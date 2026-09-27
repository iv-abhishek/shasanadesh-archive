/**
 * Pipeline stage: ingestion (registered official sources)
 *
 * Purpose:
 *   Run a source adapter's discovery, then download, hash, extract and archive
 *   each PDF it lists. Usage:
 *     npm run ingest:source -- <adapter-id> [--limit N] [--force]
 *     npm run ingest:sources            (every registered adapter in turn)
 *
 * Invariants:
 *   - documents live in data/documents/<sourceId>/ and archive/<collection>/ in
 *     B2; sourceIds carry the adapter prefix, so collections never mix
 *   - everything the listing said is kept in metadata.json (titles, related
 *     editions, the verbatim listing record) alongside capture hashes
 *   - downloads go through politeFetch (allowlist, robots.txt, crawl delay)
 *   - a file the site does not let programs fetch (robots.txt, a site that
 *     times out) can be downloaded by a person from the same official URL and
 *     saved as data/manual-downloads/<adapter>/<sourceId>.pdf; the next run uses
 *     that file, records capture.method "manual-download" and keeps the
 *     official URL as the source. Failed records are listed in NEEDED.md there.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isB2Enabled, storeCaptureInB2, type B2CaptureStorage } from "./storage/b2.js";
import { getSourceAdapter } from "./sources/registry.js";
import type { SourceAdapter, SourceDocument } from "./sources/types.js";
import { preservePreviousCapture } from "./lib/capture-history.js";
import { PDFINFO_BIN, PDFTOTEXT_BIN, crawlDelayMs } from "./lib/tool-config.js";
import { listSourceAdapters } from "./sources/registry.js";
import { politeFetch } from "./sources/http.js";
import { diskSpaceProblem } from "./storage/local-disk.js";
import { isGovernmentHost } from "./lib/government-hosts.js";

const execFileAsync = promisify(execFile);
const MAX_PDF_BYTES = 500_000_000;

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function safeSourceId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,100}$/.test(value);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function hasB2Capture(
  metadata: Record<string, unknown>,
  expectedSha256: string,
  adapter: SourceAdapter,
): boolean {
  const storage = metadata.storage as B2CaptureStorage | undefined;
  return (
    storage?.provider === "backblaze-b2-native" &&
    storage.bucket ===
      (process.env.B2_BUCKET?.trim() || process.env.B2_BUCKET_NAME?.trim()) &&
    storage.collection === adapter.collection &&
    storage.raw?.sha256 === expectedSha256 &&
    Boolean(storage.raw?.fileId) &&
    Boolean(storage.metadata?.fileId)
  );
}

async function extractPdfInfo(pdfPath: string): Promise<{ available: boolean; pages: number | null }> {
  try {
    const { stdout } = await execFileAsync(PDFINFO_BIN, [pdfPath], { maxBuffer: 5 * 1024 * 1024 });
    const match = stdout.match(/^Pages:\s+(\d+)/m);
    return { available: true, pages: match ? Number.parseInt(match[1], 10) : null };
  } catch {
    return { available: false, pages: null };
  }
}

async function extractText(pdfPath: string, textPath: string): Promise<{
  available: boolean;
  bytes: number;
  textSha256: string | null;
  normalizedTextSha256: string | null;
}> {
  try {
    await execFileAsync(PDFTOTEXT_BIN, ["-layout", "-enc", "UTF-8", pdfPath, textPath]);
    const text = await readFile(textPath, "utf8");
    const normalized = text
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return {
      available: true,
      bytes: Buffer.byteLength(text),
      textSha256: text.length ? sha256(text) : null,
      normalizedTextSha256: normalized.length ? sha256(normalized) : null,
    };
  } catch {
    return { available: false, bytes: 0, textSha256: null, normalizedTextSha256: null };
  }
}

function assertOfficialDownload(url: string, adapter: SourceAdapter): URL {
  const parsed = new URL(url);
  // Rulebook §2 (docs/RULES.md): government sources only.
  if (!isGovernmentHost(parsed.hostname)) {
    throw new Error(`Refusing ${url}: ${parsed.hostname} is not a government site (docs/RULES.md §2)`);
  }
  if (parsed.protocol !== "https:" || !adapter.allowedHosts.includes(parsed.hostname)) {
    throw new Error("Refusing download outside the adapter's HTTPS allowlist: " + url);
  }
  return parsed;
}

async function downloadPdf(record: SourceDocument, adapter: SourceAdapter): Promise<{
  bytes: Buffer;
  status: number;
  contentType: string | null;
  finalUrl: string;
}> {
  assertOfficialDownload(record.downloadUrl, adapter);
  const response = await politeFetch(record.downloadUrl, {
    allowedHosts: adapter.allowedHosts,
    accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5",
    timeoutMs: 120_000,
  });
  const finalUrl = new URL(response.url || record.downloadUrl);
  if (finalUrl.protocol !== "https:" || !adapter.allowedHosts.includes(finalUrl.hostname) || !isGovernmentHost(finalUrl.hostname)) {
    throw new Error("PDF download redirected outside the adapter's HTTPS allowlist: " + finalUrl.href);
  }
  if (!response.ok) throw new Error("PDF request returned HTTP " + response.status);
  const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > MAX_PDF_BYTES) {
    throw new Error("PDF is larger than the 500 MB per-document ingestion limit.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error("PDF is larger than the 500 MB per-document ingestion limit.");
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Download response is not a PDF (received " + (response.headers.get("content-type") ?? "unknown content type") + ").");
  }
  return {
    bytes,
    status: response.status,
    contentType: response.headers.get("content-type"),
    finalUrl: finalUrl.href,
  };
}

const MANUAL_ROOT = path.resolve("data/manual-downloads");

function manualPath(adapter: SourceAdapter, sourceId: string): string {
  return path.join(MANUAL_ROOT, adapter.id, sourceId + ".pdf");
}

/** A PDF a person saved from the record's official URL, if there is one. */
async function manualPdf(record: SourceDocument, adapter: SourceAdapter): Promise<{
  bytes: Buffer;
  status: number;
  contentType: string | null;
  finalUrl: string;
  method: "manual-download";
  file: string;
} | null> {
  const file = manualPath(adapter, record.sourceId);
  if (!(await exists(file))) return null;
  // The official URL must still pass the government / allowlist checks.
  const official = assertOfficialDownload(record.downloadUrl, adapter);
  const bytes = await readFile(file);
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error("PDF is larger than the 500 MB per-document ingestion limit.");
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Saved file is not a PDF: " + path.relative(process.cwd(), file));
  }
  return { bytes, status: 200, contentType: "application/pdf", finalUrl: official.href, method: "manual-download", file };
}

async function writeNeededList(adapter: SourceAdapter, failures: Array<{ record: SourceDocument; reason: string }>): Promise<void> {
  const dir = path.join(MANUAL_ROOT, adapter.id);
  const file = path.join(dir, "NEEDED.md");
  if (!failures.length) {
    if (await exists(file)) await writeFile(file, `# Files to download by hand — ${adapter.displayName}\n\nNothing pending.\n`);
    return;
  }
  await mkdir(dir, { recursive: true });
  const lines = [
    `# Files to download by hand — ${adapter.displayName}`,
    "",
    "The site did not let the ingester fetch these. Open each official link in a browser,",
    "save the PDF under the file name shown (in this folder), then run",
    `\`npm run ingest:source -- ${adapter.id}\` again.`,
    "",
    ...failures.flatMap(({ record, reason }) => [
      `- **${record.title}**`,
      `  - official link: ${record.downloadUrl}`,
      `  - save as: \`${record.sourceId}.pdf\``,
      `  - reason: ${reason}`,
    ]),
    "",
  ];
  await writeFile(file, lines.join("\n"));
  console.log("\nManual downloads needed: " + failures.length + " — see " + path.relative(process.cwd(), file));
}

async function persistB2(
  adapter: SourceAdapter,
  sourceId: string,
  pdf: Buffer,
  metadataPath: string,
  metadata: Record<string, unknown>,
): Promise<B2CaptureStorage> {
  const capture = metadata.capture as Record<string, unknown>;
  const captureId = typeof capture.captureId === "string" ? capture.captureId : randomUUID();
  const rawSha256 = sha256(pdf);
  if (capture.rawSha256 !== rawSha256) throw new Error("Local PDF checksum does not match capture metadata for " + sourceId);
  const storage = await storeCaptureInB2({
    collection: adapter.collection,
    sourceId,
    captureId,
    pdf,
    metadata,
  });
  await writeFile(metadataPath, JSON.stringify({ ...metadata, storage }, null, 2) + "\n");
  return storage;
}

async function ingestOne(
  record: SourceDocument,
  adapter: SourceAdapter,
  force: boolean,
  b2Enabled: boolean,
  failures: Array<{ record: SourceDocument; reason: string }> = [],
): Promise<"downloaded" | "stored" | "skipped" | "failed"> {
  if (!safeSourceId(record.sourceId)) {
    console.error("FAILED unsafe source id: " + record.sourceId);
    return "failed";
  }
  const sourceDir = path.resolve("data/documents", record.sourceId);
  const rootDir = path.resolve("data/documents") + path.sep;
  if (!sourceDir.startsWith(rootDir)) {
    console.error("FAILED source id resolved outside the document archive: " + record.sourceId);
    return "failed";
  }
  const pdfPath = path.join(sourceDir, "original.pdf");
  const textPath = path.join(sourceDir, "text.txt");
  const metadataPath = path.join(sourceDir, "metadata.json");

  try {
    await mkdir(sourceDir, { recursive: true });
    if (!force && (await exists(pdfPath)) && (await exists(metadataPath))) {
      const existingMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
      if (!b2Enabled) {
        console.log("SKIP " + record.sourceId);
        return "skipped";
      }
      const existingPdf = await readFile(pdfPath);
      const actualSha256 = sha256(existingPdf);
      const capture = existingMetadata.capture as Record<string, unknown> | undefined;
      if (typeof capture?.rawSha256 === "string" && capture.rawSha256 !== actualSha256) {
        throw new Error("Local PDF checksum does not match its metadata.");
      }
      if (hasB2Capture(existingMetadata, actualSha256, adapter)) {
        console.log("SKIP " + record.sourceId + " | already present in B2");
        return "skipped";
      }
      console.log("BACKFILL B2 " + record.sourceId);
      const storage = await persistB2(adapter, record.sourceId, existingPdf, metadataPath, existingMetadata);
      console.log("STORED " + record.sourceId + " | " + storage.bucket + "/" + storage.raw.key);
      return "stored";
    }

    console.log("\nINGEST " + record.sourceId + " | " + record.title);
    const manual = await manualPdf(record, adapter);
    if (manual) console.log("USING saved file " + path.relative(process.cwd(), manual.file) + " (official URL " + manual.finalUrl + ")");
    const response = manual ?? { ...(await downloadPdf(record, adapter)), method: "download" as const };
    // Keep the earlier capture when re-downloading with --force.
    const previousCaptures = force ? await preservePreviousCapture(sourceDir) : null;
    await writeFile(pdfPath, response.bytes);
    const pdfInfo = await extractPdfInfo(pdfPath);
    const text = await extractText(pdfPath, textPath);
    const metadata: Record<string, unknown> = {
      provider: adapter.id,
      sourceId: record.sourceId,
      sourceUrl: response.finalUrl,
      listingUrls: record.listingUrls,
      title: record.title,
      issuer: record.issuer,
      jurisdiction: record.jurisdiction,
      department: record.department,
      documentType: record.documentType,
      language: record.language,
      goDate: record.goDate,
      goNumber: record.goNumber,
      collection: adapter.collection,
      ...(record.titles ? { titles: record.titles } : {}),
      ...(record.relatedSourceIds?.length ? { relatedSourceIds: record.relatedSourceIds } : {}),
      ...(record.sourceRecord ? { sourceRecord: record.sourceRecord } : {}),
      discoveredAt: new Date().toISOString(),
      ...(previousCaptures ? { previousCaptures } : {}),
      capture: {
        method: response.method,
        downloadedAt: new Date().toISOString(),
        captureId: randomUUID(),
        status: response.status,
        contentType: response.contentType,
        bytes: response.bytes.byteLength,
        rawSha256: sha256(response.bytes),
      },
      pdf: { pages: pdfInfo.pages, pdfInfoAvailable: pdfInfo.available },
      text: {
        pdftotextAvailable: text.available,
        bytes: text.bytes,
        textSha256: text.textSha256,
        normalizedTextSha256: text.normalizedTextSha256,
        hasNativeText: text.bytes > 20,
      },
    };
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
    if (b2Enabled) {
      const storage = await persistB2(adapter, record.sourceId, response.bytes, metadataPath, metadata);
      console.log("STORED " + record.sourceId + " | " + storage.bucket + "/" + storage.raw.key);
    }
    console.log(
      "OK " + record.sourceId + " | " + response.bytes.byteLength +
      " bytes | pages=" + (pdfInfo.pages ?? "?") + " | text=" + text.bytes + " bytes",
    );
    return "downloaded";
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("FAILED " + record.sourceId + ":", reason);
    // Refused by the site (robots.txt) or unreachable: a person can fetch it.
    if (/robots\.txt|fetch failed|timed? ?out|aborted|HTTP 403/i.test(reason)) {
      failures.push({ record, reason });
    }
    return "failed";
  }
}

function parseLimit(args: string[]): number | undefined {
  const limitOption = args.find((argument) => argument.startsWith("--limit="));
  const limitIndex = args.indexOf("--limit");
  const limitValue = limitOption
    ? limitOption.slice("--limit=".length)
    : limitIndex >= 0
      ? args[limitIndex + 1]
      : undefined;
  if (limitValue === undefined) {
    if (limitIndex >= 0) throw new Error("--limit needs a positive whole number.");
    return undefined;
  }
  const parsed = Number.parseInt(limitValue, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--limit must be a positive whole number.");
  }
  return parsed;
}

interface RunTotals {
  downloaded: number;
  stored: number;
  skipped: number;
  failed: number;
}

async function runAdapter(adapter: SourceAdapter, force: boolean, limit: number | undefined): Promise<RunTotals> {
  const b2Enabled = isB2Enabled();
  console.log("\nSource:    " + adapter.displayName);
  console.log("B2:        " + (b2Enabled ? "enabled (collection " + adapter.collection + ")" : "local-only"));
  console.log("Discovering official source records...");
  const records = await adapter.discover();
  const selectedRecords = limit === undefined ? records : records.slice(0, limit);
  console.log("Discovered: " + records.length);
  console.log("Selected:   " + selectedRecords.length);
  for (const record of selectedRecords) {
    console.log("  " + (record.goDate ?? "date unknown") + " | " + record.title.slice(0, 110) + " | " + record.downloadUrl);
  }

  const totals: RunTotals = { downloaded: 0, stored: 0, skipped: 0, failed: 0 };
  const failures: Array<{ record: SourceDocument; reason: string }> = [];
  for (let index = 0; index < selectedRecords.length; index++) {
    const diskProblem = await diskSpaceProblem(process.cwd());
    if (diskProblem) {
      console.error(diskProblem);
      process.exitCode = 3;
      break;
    }
    const result = await ingestOne(selectedRecords[index], adapter, force, b2Enabled, failures);
    totals[result === "downloaded" ? "downloaded" : result === "stored" ? "stored" : result === "skipped" ? "skipped" : "failed"]++;
    if (index < selectedRecords.length - 1 && result !== "skipped") {
      await new Promise((resolve) => setTimeout(resolve, crawlDelayMs()));
    }
  }

  console.log("\nIngestion summary — " + adapter.id);
  console.log("Downloaded: " + totals.downloaded);
  console.log("Backfilled: " + totals.stored);
  console.log("Skipped:    " + totals.skipped);
  console.log("Failed:     " + totals.failed);
  await writeNeededList(adapter, failures);
  return totals;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const sourceName = args.find((argument, index) => !argument.startsWith("--") && args[index - 1] !== "--limit");
  if (!sourceName && !all) {
    throw new Error("Usage: npm run ingest:source -- <source-id> [--limit N] [--force]   or   --all");
  }
  const force = args.includes("--force");
  const limit = parseLimit(args);
  const adapters = all ? listSourceAdapters() : [getSourceAdapter(sourceName!)];

  let failed = 0;
  for (const adapter of adapters) {
    try {
      failed += (await runAdapter(adapter, force, limit)).failed;
    } catch (error) {
      // One site being down must not stop the others in an --all run.
      failed++;
      console.error("SOURCE FAILED " + adapter.id + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
