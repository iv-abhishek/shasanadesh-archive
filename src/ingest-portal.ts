/**
 * Pipeline stage: Shasanadesh portal import (npm run ingest:portal)
 *
 * Purpose:
 *   Download every order listed by the portal bridge (data/portal-capture/
 *   inventory.jsonl), keep its listing metadata, and archive the original PDF
 *   and a manifest in B2 (collection "shasanadesh"). Resumable: outcomes are
 *   appended to ingest-status.jsonl and a restart continues where it stopped.
 *
 * Options:
 *   --until-idle           exit once every listed order has a final outcome,
 *                          instead of waiting for the bridge to add more
 *   --keep-routine-local   keep local PDFs of routine orders (see below)
 *   --evict-existing       one-off: apply the disk policy to orders already
 *                          downloaded, then exit (no network requests)
 *
 * Disk policy (ADR-052): orders the classifier is confident are routine or
 *   individual (tier C: sanctions, releases, one person/place) are archived
 *   in B2 and their local original.pdf is removed after the upload's checksum
 *   is verified; metadata.json and text.txt stay. The viewer falls back to the
 *   official portal link. Guideline-type orders keep their local PDF for OCR.
 *
 * Invariants:
 *   - requests only official Shasanadesh PDF links, at the configured crawl
 *     delay (>= 3 s), with the configured crawler identity
 *   - a local PDF is removed only when B2 holds the same bytes (sha256)
 *   - never solves or bypasses a CAPTCHA; listing capture is done by a person
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { decodeShasanadeshId } from "./lib/shasanadesh-id.js";
import { crawlDelayMs, crawlerUserAgent, PDFINFO_BIN, PDFTOTEXT_BIN } from "./lib/tool-config.js";
import { preservePreviousCapture } from "./lib/capture-history.js";
import { isB2Enabled, refreshCaptureManifestInB2, storeCaptureInB2, type B2CaptureStorage } from "./storage/b2.js";
import { classifyOrder } from "./classify/rules.js";
import { diskSpaceProblem } from "./storage/local-disk.js";

const UNTIL_IDLE = process.argv.includes("--until-idle");
const KEEP_ROUTINE_LOCAL = process.argv.includes("--keep-routine-local");

const execFileAsync = promisify(execFile);
const DATA_DIR = path.resolve("data/portal-capture");
const INVENTORY_PATH = path.join(DATA_DIR, "inventory.jsonl");
const STATUS_PATH = path.join(DATA_DIR, "ingest-status.jsonl");
const COMPLETE_PATH = path.join(DATA_DIR, "complete.json");
const documentsRoot = path.resolve("data/documents");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface PortalRecord {
  sourceId: string;
  encodedId: string;
  sourceUrl: string;
  portalPage: number;
  portalRow: number | null;
  capturedAt: string;
  department: string | null;
  section: string | null;
  goNumber: string | null;
  goDate: string | null;
  category: string | null;
  subject: string | null;
  linkText: string | null;
}

interface StatusRecord {
  sourceId: string;
  state: "stored" | "skipped" | "retry" | "unavailable";
  attempt: number;
  recordedAt: string;
  detail?: string;
  retryAt?: string;
}

interface KnownMetadata extends Record<string, unknown> {
  sourceId?: string;
  storage?: B2CaptureStorage;
  capture?: Record<string, unknown>;
  portal?: Record<string, unknown>;
  localCopy?: { state: "evicted"; reason: string; at: string };
}

const records = new Map<string, PortalRecord>();
/** Saved orders whose inventory gained row details after they were stored. */
const detailsPending = new Set<string>();
const succeeded = new Set<string>();
const unavailable = new Set<string>();
const attempts = new Map<string, number>();
const retryAt = new Map<string, number>();
let inventoryOffset = 0;
let inventoryTail = "";
let lastPdfRequestAt = 0;
let attemptedSinceReport = 0;
let storedSinceReport = 0;
let failedSinceReport = 0;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceDirectory(sourceId: string): string {
  return sourceId.replaceAll("#", "-");
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function portalFields(record: PortalRecord): Record<string, unknown> {
  return {
    sourceUrl: record.sourceUrl,
    department: record.department,
    goDate: record.goDate,
    goNumber: record.goNumber,
    verificationStatus: "downloaded",
    evidenceUrl: record.sourceUrl,
    portal: {
      resultPage: record.portalPage,
      resultRow: record.portalRow,
      department: record.department,
      section: record.section,
      category: record.category,
      subject: record.subject,
      linkText: record.linkText,
      capturedAt: record.capturedAt,
    },
  };
}

/** An inventory line captured without the row's subject and date. */
function isThin(record: PortalRecord): boolean {
  return !record.subject && !record.goDate;
}

function hasVerifiedB2(metadata: KnownMetadata, expectedSha256: string): boolean {
  const storage = metadata.storage;
  const bucket = process.env.B2_BUCKET?.trim() || process.env.B2_BUCKET_NAME?.trim();
  return storage?.provider === "backblaze-b2-native" && storage.bucket === bucket &&
    storage.raw?.sha256 === expectedSha256 && Boolean(storage.raw?.fileId) &&
    Boolean(storage.metadata?.fileId);
}

function validateRecord(record: PortalRecord): string {
  const decoded = decodeShasanadeshId(record.encodedId);
  if (decoded.decodedId !== record.sourceId) throw new Error(`Inventory ID mismatch for ${record.sourceId}.`);
  const url = new URL(record.sourceUrl);
  if (url.origin !== "https://shasanadesh.up.gov.in" || url.pathname !== "/GO/ViewGOPDF_list_user.aspx" ||
      url.searchParams.get("id1") !== decoded.base64) {
    throw new Error(`Inventory URL is not the matching official PDF URL for ${record.sourceId}.`);
  }
  return decoded.decodedId;
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

async function extractText(pdfPath: string, textPath: string): Promise<Record<string, unknown>> {
  try {
    await execFileAsync(PDFTOTEXT_BIN, ["-layout", "-enc", "UTF-8", pdfPath, textPath]);
    const text = await readFile(textPath, "utf8");
    const normalized = normalizeText(text);
    return {
      pdftotextAvailable: true,
      bytes: Buffer.byteLength(text),
      textSha256: text.length ? sha256(text) : null,
      normalizedTextSha256: normalized.length ? sha256(normalized) : null,
      hasNativeText: Buffer.byteLength(text) > 20,
    };
  } catch {
    return { pdftotextAvailable: false, bytes: 0, textSha256: null, normalizedTextSha256: null, hasNativeText: false };
  }
}

async function waitForPdfRateLimit(): Promise<void> {
  const delay = crawlDelayMs();
  const remaining = delay - (Date.now() - lastPdfRequestAt);
  if (lastPdfRequestAt && remaining > 0) await wait(remaining);
  lastPdfRequestAt = Date.now();
}

async function downloadPdf(record: PortalRecord): Promise<{ bytes: Buffer; response: Response }> {
  await waitForPdfRateLimit();
  const response = await fetch(record.sourceUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": crawlerUserAgent(process.env.SHASANADESH_USER_AGENT),
      Accept: "application/pdf,text/html;q=0.9,*/*;q=0.8",
      "Accept-Language": "hi-IN,hi;q=0.9,en-IN;q=0.8,en;q=0.7",
    },
    signal: AbortSignal.timeout(90_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    const detail = `HTTP ${response.status}, ${response.headers.get("content-type") ?? "unknown content type"}`;
    const error = new Error(detail) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return { bytes, response };
}

async function saveExistingCapture(record: PortalRecord, pdf: Buffer, metadata: KnownMetadata, metadataPath: string): Promise<"stored" | "skipped"> {
  const digest = sha256(pdf);
  const priorCapture = metadata.capture ?? {};
  const captureId = typeof priorCapture.captureId === "string" && priorCapture.captureId.length
    ? priorCapture.captureId
    : `legacy-${digest.slice(0, 16)}`;
  const updated: KnownMetadata = {
    ...metadata,
    ...portalFields(record),
    sourceId: record.sourceId,
    capture: { ...priorCapture, captureId, bytes: pdf.byteLength, rawSha256: digest },
  };
  if (hasVerifiedB2(metadata, digest)) {
    const refreshed = await refreshCaptureManifestInB2({
      sourceId: record.sourceId,
      captureId,
      metadata: updated,
      storage: metadata.storage!,
    });
    updated.storage = refreshed;
    await atomicJson(metadataPath, updated);
    return "skipped";
  }
  const storage = await storeCaptureInB2({ sourceId: record.sourceId, captureId, pdf, metadata: updated });
  updated.storage = storage;
  await atomicJson(metadataPath, updated);
  return "stored";
}

async function ingest(record: PortalRecord): Promise<"stored" | "skipped"> {
  validateRecord(record);
  const sourceDir = path.join(documentsRoot, sourceDirectory(record.sourceId));
  const pdfPath = path.join(sourceDir, "original.pdf");
  const textPath = path.join(sourceDir, "text.txt");
  const metadataPath = path.join(sourceDir, "metadata.json");
  await mkdir(sourceDir, { recursive: true });

  const localPdf = await readFile(pdfPath).catch(() => null);
  const localMetadata = await readFile(metadataPath, "utf8").then((value) => JSON.parse(value) as KnownMetadata).catch(() => null);

  // Routine order already archived in B2 and removed locally: nothing to do.
  const archivedSha = (localMetadata?.capture as Record<string, unknown> | undefined)?.rawSha256;
  if (
    !localPdf &&
    localMetadata?.localCopy?.state === "evicted" &&
    typeof archivedSha === "string" &&
    hasVerifiedB2(localMetadata, archivedSha)
  ) {
    return "skipped";
  }
  if (localPdf && localMetadata && localPdf.subarray(0, 5).toString("ascii") === "%PDF-") {
    const captureSha = (localMetadata.capture as Record<string, unknown> | undefined)?.rawSha256;
    if (!captureSha || captureSha === sha256(localPdf)) {
      return saveExistingCapture(record, localPdf, localMetadata, metadataPath);
    }
  }

  const { bytes, response } = await downloadPdf(record);
  const previousCaptures = localPdf ? await preservePreviousCapture(sourceDir) : null;
  const temporaryPdf = `${pdfPath}.part`;
  await writeFile(temporaryPdf, bytes);
  await rename(temporaryPdf, pdfPath);
  const pdfInfo = await extractPdfInfo(pdfPath);
  const text = await extractText(pdfPath, textPath);
  const metadata: KnownMetadata = {
    provider: "shasanadesh-up",
    sourceId: record.sourceId,
    encodedId: record.encodedId,
    ...portalFields(record),
    idParts: decodeShasanadeshId(record.encodedId).parts,
    ...(previousCaptures ? { previousCaptures } : {}),
    capture: {
      downloadedAt: new Date().toISOString(),
      captureId: randomUUID(),
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: bytes.byteLength,
      rawSha256: sha256(bytes),
    },
    pdf: { pages: pdfInfo.pages, pdfInfoAvailable: pdfInfo.available },
    text,
  };
  await atomicJson(metadataPath, metadata);
  const storage = await storeCaptureInB2({
    sourceId: record.sourceId,
    captureId: String((metadata.capture as Record<string, unknown>).captureId),
    pdf: bytes,
    metadata,
  });
  metadata.storage = storage;
  await atomicJson(metadataPath, metadata);
  await evictIfRoutine(record, metadata, metadataPath, pdfPath);
  return "stored";
}

/**
 * Remove the local PDF of a confidently routine order once B2 holds the same
 * bytes. Keeps metadata.json and text.txt (small, used for classification).
 */
async function evictIfRoutine(
  record: PortalRecord,
  metadata: KnownMetadata,
  metadataPath: string,
  pdfPath: string,
): Promise<void> {
  if (KEEP_ROUTINE_LOCAL) return;
  const classification = classifyOrder(record);
  if (classification.tier !== "C" || classification.confidence !== "high") return;
  const sha = (metadata.capture as Record<string, unknown> | undefined)?.rawSha256;
  if (typeof sha !== "string" || !hasVerifiedB2(metadata, sha)) return;
  await rm(pdfPath, { force: true });
  metadata.localCopy = {
    state: "evicted",
    reason: `routine order (${classification.docType}); original kept in B2`,
    at: new Date().toISOString(),
  };
  await atomicJson(metadataPath, metadata);
}

async function writeStatus(status: StatusRecord): Promise<void> {
  await appendFile(STATUS_PATH, `${JSON.stringify(status)}\n`, "utf8");
}

function parseInventoryLine(line: string): PortalRecord {
  const record = JSON.parse(line) as PortalRecord;
  validateRecord(record);
  return record;
}

async function loadStatus(): Promise<void> {
  const content = await readFile(STATUS_PATH, "utf8").catch(() => "");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const status = JSON.parse(line) as StatusRecord;
    attempts.set(status.sourceId, Math.max(attempts.get(status.sourceId) ?? 0, status.attempt));
    if (status.state === "stored" || status.state === "skipped") succeeded.add(status.sourceId);
    if (status.state === "unavailable") unavailable.add(status.sourceId);
    if (status.state === "retry" && status.retryAt) retryAt.set(status.sourceId, Date.parse(status.retryAt));
    if (status.state !== "retry") retryAt.delete(status.sourceId);
  }
}

async function loadInventoryGrowth(): Promise<void> {
  const size = await stat(INVENTORY_PATH).then((value) => value.size).catch(() => 0);
  if (size <= inventoryOffset) return;
  const file = await open(INVENTORY_PATH, "r");
  try {
    const length = size - inventoryOffset;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, inventoryOffset);
    inventoryOffset += bytesRead;
    const combined = inventoryTail + buffer.subarray(0, bytesRead).toString("utf8");
    const lines = combined.split(/\r?\n/);
    inventoryTail = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const record = parseInventoryLine(line);
      const known = records.get(record.sourceId);
      if (!known) {
        records.set(record.sourceId, record);
      } else if (isThin(known) && !isThin(record)) {
        // A later capture of the same order carries the row details the first
        // one missed; it replaces the thin line (the first capture still wins
        // otherwise).
        records.set(record.sourceId, record);
        detailsPending.add(record.sourceId);
      }
    }
  } finally {
    await file.close();
  }
}

/**
 * Write the fuller row details into metadata.json (and the B2 manifest) of an
 * order that was stored before its details were captured. No portal request.
 */
async function refreshDetails(record: PortalRecord): Promise<boolean> {
  const sourceDir = path.join(documentsRoot, sourceDirectory(record.sourceId));
  const metadataPath = path.join(sourceDir, "metadata.json");
  const metadata = await readFile(metadataPath, "utf8").then((value) => JSON.parse(value) as KnownMetadata).catch(() => null);
  if (!metadata) return false;
  const portal = metadata.portal ?? {};
  if (portal.subject === record.subject && portal.section === record.section && metadata.goDate === record.goDate) return false;
  const updated: KnownMetadata = { ...metadata, ...portalFields(record) };
  const captureId = (metadata.capture as Record<string, unknown> | undefined)?.captureId;
  const sha = (metadata.capture as Record<string, unknown> | undefined)?.rawSha256;
  if (typeof captureId === "string" && typeof sha === "string" && hasVerifiedB2(metadata, sha)) {
    updated.storage = await refreshCaptureManifestInB2({ sourceId: record.sourceId, captureId, metadata: updated, storage: metadata.storage! });
  }
  await atomicJson(metadataPath, updated);
  // With a subject the classifier can now judge the order; routine ones free
  // their local PDF as usual.
  await evictIfRoutine(record, updated, metadataPath, path.join(sourceDir, "original.pdf"));
  return true;
}

async function refreshPendingDetails(): Promise<void> {
  let updated = 0;
  for (const sourceId of [...detailsPending]) {
    if (!succeeded.has(sourceId)) {
      detailsPending.delete(sourceId); // not stored yet: the download uses the fuller line
      continue;
    }
    try {
      if (await refreshDetails(records.get(sourceId)!)) updated++;
      detailsPending.delete(sourceId);
    } catch (error) {
      console.error(`DETAILS ${sourceId}: ${error instanceof Error ? error.message : String(error)} (will retry)`);
      return;
    }
  }
  if (updated) console.log(`Row details filled in for ${updated} saved orders.`);
}

async function isComplete(): Promise<{ complete: boolean; expected: number | null }> {
  try {
    const marker = JSON.parse(await readFile(COMPLETE_PATH, "utf8")) as { expectedRecords?: number };
    return { complete: Number.isInteger(marker.expectedRecords), expected: marker.expectedRecords ?? null };
  } catch {
    return { complete: false, expected: null };
  }
}

/** --evict-existing: apply the disk policy to already-downloaded orders. */
async function evictExisting(): Promise<void> {
  await loadInventoryGrowth();
  let evicted = 0;
  let kept = 0;
  let freedBytes = 0;
  for (const record of records.values()) {
    const sourceDir = path.join(documentsRoot, sourceDirectory(record.sourceId));
    const pdfPath = path.join(sourceDir, "original.pdf");
    const metadataPath = path.join(sourceDir, "metadata.json");
    const size = await stat(pdfPath).then((value) => value.size).catch(() => 0);
    if (!size) continue;
    const metadata = await readFile(metadataPath, "utf8").then((value) => JSON.parse(value) as KnownMetadata).catch(() => null);
    if (!metadata) continue;
    await evictIfRoutine(record, metadata, metadataPath, pdfPath);
    if (metadata.localCopy?.state === "evicted") {
      evicted++;
      freedBytes += size;
    } else {
      kept++;
    }
  }
  console.log(`Local PDFs removed (routine, verified in B2): ${evicted}, freed ${(freedBytes / 1e6).toFixed(1)} MB; kept locally: ${kept}.`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--evict-existing")) {
    if (KEEP_ROUTINE_LOCAL) throw new Error("--evict-existing and --keep-routine-local contradict each other.");
    await evictExisting();
    return;
  }
  if (!isB2Enabled()) throw new Error("B2 is not configured. The portal importer refuses to run local-only.");
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(documentsRoot, { recursive: true });
  await loadStatus();
  console.log("Shasanadesh portal ingestion active; B2 is required; source PDF requests are rate limited.");
  console.log(`Inventory: ${INVENTORY_PATH}`);
  console.log(`Already completed: ${succeeded.size}; previously unavailable: ${unavailable.size}`);

  for (;;) {
    await loadInventoryGrowth();
    await refreshPendingDetails();
    const now = Date.now();
    let candidate: PortalRecord | undefined;
    for (const record of records.values()) {
      if (succeeded.has(record.sourceId) || unavailable.has(record.sourceId)) continue;
      if ((retryAt.get(record.sourceId) ?? 0) > now) continue;
      candidate = record;
      break;
    }

    if (candidate) {
      const diskProblem = await diskSpaceProblem(documentsRoot);
      if (diskProblem) {
        console.error(diskProblem);
        process.exitCode = 3;
        return;
      }
      const attempt = (attempts.get(candidate.sourceId) ?? 0) + 1;
      attempts.set(candidate.sourceId, attempt);
      attemptedSinceReport++;
      try {
        const outcome = await ingest(candidate);
        succeeded.add(candidate.sourceId);
        retryAt.delete(candidate.sourceId);
        await writeStatus({ sourceId: candidate.sourceId, state: outcome, attempt, recordedAt: new Date().toISOString() });
        storedSinceReport += outcome === "stored" ? 1 : 0;
      } catch (error) {
        failedSinceReport++;
        const detail = error instanceof Error ? error.message : String(error);
        const httpStatus = (error as { status?: number }).status;
        if (httpStatus === 404 || httpStatus === 410) {
          unavailable.add(candidate.sourceId);
          retryAt.delete(candidate.sourceId);
          await writeStatus({ sourceId: candidate.sourceId, state: "unavailable", attempt, detail, recordedAt: new Date().toISOString() });
          console.error(`UNAVAILABLE ${candidate.sourceId} after HTTP ${httpStatus}`);
        } else {
          const backoff = Math.min(30 * 60_000, Math.max(30_000, 30_000 * 2 ** Math.min(attempt - 1, 6)));
          const next = new Date(Date.now() + backoff);
          retryAt.set(candidate.sourceId, next.getTime());
          await writeStatus({ sourceId: candidate.sourceId, state: "retry", attempt, detail, retryAt: next.toISOString(), recordedAt: new Date().toISOString() });
          console.error(`RETRY ${candidate.sourceId} attempt=${attempt} at ${next.toISOString()}: ${detail}`);
        }
      }

      if (attemptedSinceReport >= 25) {
        console.log(`Progress: saved=${succeeded.size}, newB2=${storedSinceReport}, unavailable=${unavailable.size}, inventory=${records.size}, recentFailures=${failedSinceReport}`);
        attemptedSinceReport = 0;
        storedSinceReport = 0;
        failedSinceReport = 0;
      }
      continue;
    }

    const terminal = succeeded.size + unavailable.size;
    const waitingRetries = [...retryAt.values()].some((time) => time > Date.now());
    if (UNTIL_IDLE && terminal >= records.size && !waitingRetries) {
      console.log(`Portal ingestion idle: saved=${succeeded.size}, unavailable=${unavailable.size}, listed=${records.size}.`);
      if (unavailable.size) process.exitCode = 2;
      return;
    }
    const completion = await isComplete();
    if (completion.complete && records.size >= (completion.expected ?? Number.POSITIVE_INFINITY) && terminal >= records.size) {
      console.log(`Portal ingestion finished: saved=${succeeded.size}, unavailable=${unavailable.size}, unique inventory=${records.size}, portal expected=${completion.expected}.`);
      if (unavailable.size) process.exitCode = 2;
      return;
    }
    await wait(10_000);
  }
}

main().catch((error) => {
  console.error("Portal ingestion stopped:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
