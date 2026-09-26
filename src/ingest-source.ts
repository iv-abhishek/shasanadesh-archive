import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isB2Enabled, storeCaptureInB2, type B2CaptureStorage } from "./storage/b2.js";
import { getSourceAdapter } from "./sources/registry.js";
import type { SourceAdapter, SourceDocument } from "./sources/types.js";
import { preservePreviousCapture } from "./lib/capture-history.js";
import { PDFINFO_BIN, PDFTOTEXT_BIN, crawlDelayMs, crawlerUserAgent } from "./lib/tool-config.js";

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
  const response = await fetch(record.downloadUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": crawlerUserAgent(),
      Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5",
      "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
    },
    signal: AbortSignal.timeout(120_000),
  });
  const finalUrl = new URL(response.url || record.downloadUrl);
  if (finalUrl.protocol !== "https:" || !adapter.allowedHosts.includes(finalUrl.hostname)) {
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
    const response = await downloadPdf(record, adapter);
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
      ...(previousCaptures ? { previousCaptures } : {}),
      capture: {
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
    console.error(
      "FAILED " + record.sourceId + ":",
      error instanceof Error ? error.message : String(error),
    );
    return "failed";
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sourceName = args.find((argument) => !argument.startsWith("--"));
  if (!sourceName) {
    throw new Error("Usage: npm run ingest:source -- <source-id> [--limit N] [--force]");
  }
  const adapter = getSourceAdapter(sourceName);
  const force = args.includes("--force");
  const limitOption = args.find((argument) => argument.startsWith("--limit="));
  const limitIndex = args.indexOf("--limit");
  const limitValue = limitOption
    ? limitOption.slice("--limit=".length)
    : limitIndex >= 0
      ? args[limitIndex + 1]
      : undefined;
  let limit: number | undefined;
  if (limitValue !== undefined) {
    const parsed = Number.parseInt(limitValue, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error("--limit must be a positive whole number.");
    }
    limit = parsed;
  } else if (limitIndex >= 0) {
    throw new Error("--limit needs a positive whole number.");
  }
  const b2Enabled = isB2Enabled();

  console.log("Source:    " + adapter.displayName);
  console.log("B2:        " + (b2Enabled ? "enabled" : "local-only"));
  console.log("Discovering official source records...");
  const records = await adapter.discover();
  const selectedRecords = limit === undefined ? records : records.slice(0, limit);
  console.log("Discovered: " + records.length);
  console.log("Selected:   " + selectedRecords.length);
  for (const record of selectedRecords) {
    console.log("  " + (record.goDate ?? "date unknown") + " | " + record.title + " | " + record.downloadUrl);
  }

  let downloaded = 0;
  let stored = 0;
  let skipped = 0;
  let failed = 0;
  for (let index = 0; index < selectedRecords.length; index++) {
    const result = await ingestOne(selectedRecords[index], adapter, force, b2Enabled);
    if (result === "downloaded") downloaded++;
    if (result === "stored") stored++;
    if (result === "skipped") skipped++;
    if (result === "failed") failed++;
    if (index < selectedRecords.length - 1 && result !== "skipped") {
      await new Promise((resolve) => setTimeout(resolve, crawlDelayMs()));
    }
  }

  console.log("\nIngestion summary");
  console.log("Downloaded: " + downloaded);
  console.log("Backfilled: " + stored);
  console.log("Skipped:    " + skipped);
  console.log("Failed:     " + failed);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
