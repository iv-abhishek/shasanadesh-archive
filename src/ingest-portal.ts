import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { decodeShasanadeshId } from "./lib/shasanadesh-id.js";
import { crawlDelayMs, crawlerUserAgent, PDFINFO_BIN, PDFTOTEXT_BIN } from "./lib/tool-config.js";
import { preservePreviousCapture } from "./lib/capture-history.js";
import { isB2Enabled, refreshCaptureManifestInB2, storeCaptureInB2, type B2CaptureStorage } from "./storage/b2.js";

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
}

const records = new Map<string, PortalRecord>();
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
  return "stored";
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
      if (!records.has(record.sourceId)) records.set(record.sourceId, record);
    }
  } finally {
    await file.close();
  }
}

async function isComplete(): Promise<{ complete: boolean; expected: number | null }> {
  try {
    const marker = JSON.parse(await readFile(COMPLETE_PATH, "utf8")) as { expectedRecords?: number };
    return { complete: Number.isInteger(marker.expectedRecords), expected: marker.expectedRecords ?? null };
  } catch {
    return { complete: false, expected: null };
  }
}

async function main(): Promise<void> {
  if (!isB2Enabled()) throw new Error("B2 is not configured. The portal importer refuses to run local-only.");
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(documentsRoot, { recursive: true });
  await loadStatus();
  console.log("Shasanadesh portal ingestion active; B2 is required; source PDF requests are rate limited.");
  console.log(`Inventory: ${INVENTORY_PATH}`);
  console.log(`Already completed: ${succeeded.size}; previously unavailable: ${unavailable.size}`);

  for (;;) {
    await loadInventoryGrowth();
    const now = Date.now();
    let candidate: PortalRecord | undefined;
    for (const record of records.values()) {
      if (succeeded.has(record.sourceId) || unavailable.has(record.sourceId)) continue;
      if ((retryAt.get(record.sourceId) ?? 0) > now) continue;
      candidate = record;
      break;
    }

    if (candidate) {
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

    const completion = await isComplete();
    const terminal = succeeded.size + unavailable.size;
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
