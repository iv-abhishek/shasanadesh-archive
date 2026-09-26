/**
 * Shasanadesh Archive — documented pipeline file
 *
 * Pipeline stage: ingestion
 * Purpose: Capture known PDFs and generate provenance/text metadata.
 *
 * Invariants:
 * - preserve source provenance and stable source/page identifiers
 * - keep raw/native/OCR variants auditable instead of silently overwriting evidence
 * - keep parameters explicit and documented when they affect corpus/search quality
 *
 * Project hand-off docs:
 * - docs/PROJECT_MEMORY.md
 * - docs/ARCHITECTURE.md
 * - docs/CONFIGURATION.md
 * - docs/DECISIONS.md
 */

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildShasanadeshPdfUrl,
  decodeShasanadeshId,
} from "./lib/shasanadesh-id.js";
import {
  isB2Enabled,
  storeCaptureInB2,
  type B2CaptureStorage,
} from "./storage/b2.js";
import { preservePreviousCapture } from "./lib/capture-history.js";
import {
  PDFINFO_BIN,
  PDFTOTEXT_BIN,
  crawlDelayMs,
  crawlerUserAgent,
} from "./lib/tool-config.js";

const execFileAsync = promisify(execFile);

interface KnownId {
  encodedId: string;
  decodedId: string;
  department: string | null;
  goDate: string | null;
  goNumber: string | null;
  verificationStatus: "downloaded" | "public-reference";
  evidenceUrl: string;
}

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function captureDetails(metadata: Record<string, unknown>): Record<string, unknown> {
  const capture = metadata.capture;
  return capture && typeof capture === "object"
    ? (capture as Record<string, unknown>)
    : {};
}

function hasVerifiedB2Capture(
  metadata: Record<string, unknown>,
  expectedSha256: string,
): boolean {
  const storage = metadata.storage as B2CaptureStorage | undefined;
  return (
    storage?.provider === "backblaze-b2-native" &&
    storage.bucket ===
      (process.env.B2_BUCKET?.trim() || process.env.B2_BUCKET_NAME?.trim()) &&
    storage.raw?.sha256 === expectedSha256 &&
    Boolean(storage.raw?.fileId) &&
    storage.metadata?.sha256 !== undefined &&
    Boolean(storage.metadata?.fileId)
  );
}

async function storeLocalCapture(
  sourceId: string,
  pdf: Buffer,
  metadataPath: string,
  metadata: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const capture = captureDetails(metadata);
  const rawSha256 = sha256(pdf);
  const recordedSha256 = capture.rawSha256;
  if (typeof recordedSha256 === "string" && recordedSha256 !== rawSha256) {
    throw new Error(
      `Local PDF checksum does not match its metadata for ${sourceId}.`,
    );
  }

  const captureId =
    typeof capture.captureId === "string" && capture.captureId.length > 0
      ? capture.captureId
      : `legacy-${rawSha256.slice(0, 16)}`;
  const preparedMetadata = {
    ...metadata,
    capture: {
      ...capture,
      captureId,
      bytes: pdf.byteLength,
      rawSha256,
    },
  };
  const storage = await storeCaptureInB2({
    sourceId,
    captureId,
    pdf,
    metadata: preparedMetadata,
  });
  const completedMetadata = { ...preparedMetadata, storage };
  await writeFile(
    metadataPath,
    JSON.stringify(completedMetadata, null, 2) + "\n",
  );
  return completedMetadata;
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sourceDirName(sourceId: string): string {
  return sourceId.replaceAll("#", "-");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function extractPdfInfo(pdfPath: string): Promise<{
  available: boolean;
  pages: number | null;
  raw: string | null;
}> {
  try {
    const { stdout } = await execFileAsync(PDFINFO_BIN, [pdfPath], {
      maxBuffer: 5 * 1024 * 1024,
    });

    const match = stdout.match(/^Pages:\s+(\d+)/m);

    return {
      available: true,
      pages: match ? Number.parseInt(match[1], 10) : null,
      raw: stdout,
    };
  } catch {
    return {
      available: false,
      pages: null,
      raw: null,
    };
  }
}

async function extractText(
  pdfPath: string,
  textPath: string,
): Promise<{
  available: boolean;
  bytes: number;
  textSha256: string | null;
  normalizedTextSha256: string | null;
}> {
  try {
    await execFileAsync(PDFTOTEXT_BIN, [
      "-layout",
      "-enc",
      "UTF-8",
      pdfPath,
      textPath,
    ]);

    const text = await readFile(textPath, "utf8");
    const normalized = normalizeText(text);

    return {
      available: true,
      bytes: Buffer.byteLength(text),
      textSha256: text.length > 0 ? sha256(text) : null,
      normalizedTextSha256:
        normalized.length > 0 ? sha256(normalized) : null,
    };
  } catch {
    return {
      available: false,
      bytes: 0,
      textSha256: null,
      normalizedTextSha256: null,
    };
  }
}

async function ingestOne(
  record: KnownId,
  force: boolean,
  b2Enabled: boolean,
): Promise<"downloaded" | "stored" | "skipped" | "failed"> {
  const decoded = decodeShasanadeshId(record.encodedId);
  const sourceDir = path.resolve(
    "data/documents",
    sourceDirName(decoded.decodedId),
  );

  const pdfPath = path.join(sourceDir, "original.pdf");
  const textPath = path.join(sourceDir, "text.txt");
  const metadataPath = path.join(sourceDir, "metadata.json");

  await mkdir(sourceDir, { recursive: true });

  try {
    if (!force && (await exists(pdfPath)) && (await exists(metadataPath))) {
      if (!b2Enabled) {
        console.log(`SKIP ${decoded.decodedId}`);
        return "skipped";
      }

      const existingMetadata = JSON.parse(
        await readFile(metadataPath, "utf8"),
      ) as Record<string, unknown>;
      const existingPdf = await readFile(pdfPath);
      const actualSha256 = sha256(existingPdf);
      const capture = captureDetails(existingMetadata);
      if (
        typeof capture.rawSha256 === "string" &&
        capture.rawSha256 !== actualSha256
      ) {
        throw new Error(
          `Local PDF checksum does not match its metadata for ${decoded.decodedId}.`,
        );
      }

      if (hasVerifiedB2Capture(existingMetadata, actualSha256)) {
        console.log(`SKIP ${decoded.decodedId} | already present in B2`);
        return "skipped";
      }

      console.log(`\nBACKFILL B2 ${decoded.decodedId}`);
      const completedMetadata = await storeLocalCapture(
        decoded.decodedId,
        existingPdf,
        metadataPath,
        existingMetadata,
      );
      const storage = completedMetadata.storage as B2CaptureStorage;
      console.log(
        `STORED ${decoded.decodedId} | ${storage.bucket}/${storage.raw.key} | sha1=${storage.raw.sha1}`,
      );
      return "stored";
    }

    const sourceUrl = buildShasanadeshPdfUrl(decoded.base64);

    console.log(`\nINGEST ${decoded.decodedId}`);
    console.log(sourceUrl);

    const response = await fetch(sourceUrl, {
      redirect: "follow",
      headers: {
        // Identify the archive honestly. SHASANADESH_USER_AGENT can override
        // this if the site ever requires a different client string.
        "User-Agent": crawlerUserAgent(process.env.SHASANADESH_USER_AGENT),
        Accept: "application/pdf,text/html;q=0.9,*/*;q=0.8",
        "Accept-Language": "hi-IN,hi;q=0.9,en-IN;q=0.8,en;q=0.7",
      },
      signal: AbortSignal.timeout(60_000),
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    const isPdf =
      response.ok &&
      buffer.subarray(0, 5).toString("ascii") === "%PDF-";

    if (!isPdf) {
      console.log(
        `FAILED ${decoded.decodedId}: HTTP ${response.status}, ${response.headers.get("content-type")}`,
      );
      return "failed";
    }

    // Keep the earlier capture when re-downloading with --force.
    const previousCaptures = force
      ? await preservePreviousCapture(sourceDir)
      : null;

    await writeFile(pdfPath, buffer);

    const pdfInfo = await extractPdfInfo(pdfPath);
    const text = await extractText(pdfPath, textPath);

    const metadata = {
      provider: "shasanadesh-up",
      sourceId: decoded.decodedId,
      encodedId: decoded.base64,
      sourceUrl,
      department: record.department,
      goDate: record.goDate,
      goNumber: record.goNumber,
      verificationStatus: record.verificationStatus,
      evidenceUrl: record.evidenceUrl,

      idParts: decoded.parts,
      ...(previousCaptures ? { previousCaptures } : {}),

      capture: {
        downloadedAt: new Date().toISOString(),
        captureId: randomUUID(),
        status: response.status,
        contentType: response.headers.get("content-type"),
        bytes: buffer.length,
        rawSha256: sha256(buffer),
      },

      pdf: {
        pages: pdfInfo.pages,
        pdfInfoAvailable: pdfInfo.available,
      },

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
      const completedMetadata = await storeLocalCapture(
        decoded.decodedId,
        buffer,
        metadataPath,
        metadata,
      );
      const storage = completedMetadata.storage as B2CaptureStorage;
      console.log(
        `STORED ${decoded.decodedId} | ${storage.bucket}/${storage.raw.key} | sha1=${storage.raw.sha1}`,
      );
    }

    console.log(
      `OK ${decoded.decodedId} | ${buffer.length} bytes | pages=${pdfInfo.pages ?? "?"} | text=${text.bytes} bytes`,
    );

    return "downloaded";
  } catch (error) {
    console.error(
      `FAILED ${decoded.decodedId}:`,
      error instanceof Error ? error.message : String(error),
    );

    return "failed";
  }
}

async function main() {
  const force = process.argv.includes("--force");
  const b2Enabled = isB2Enabled();
  const datasetPath = path.resolve("datasets/known-ids.json");

  const records = JSON.parse(
    await readFile(datasetPath, "utf8"),
  ) as KnownId[];

  console.log(`Known IDs: ${records.length}`);
  console.log(`Force:     ${force ? "yes" : "no"}`);
  console.log(`B2:        ${b2Enabled ? "enabled" : "local-only"}`);

  let downloaded = 0;
  let stored = 0;
  let skipped = 0;
  let failed = 0;

  for (let index = 0; index < records.length; index++) {
    const result = await ingestOne(records[index], force, b2Enabled);

    if (result === "downloaded") downloaded++;
    if (result === "stored") stored++;
    if (result === "skipped") skipped++;
    if (result === "failed") failed++;

    if (index < records.length - 1 && result !== "skipped") {
      await new Promise((resolve) => setTimeout(resolve, crawlDelayMs()));
    }
  }

  console.log("\n====================");
  console.log("Ingestion summary");
  console.log("====================");
  console.log(`Downloaded: ${downloaded}`);
  console.log(`Backfilled: ${stored}`);
  console.log(`Skipped:    ${skipped}`);
  console.log(`Failed:     ${failed}`);
  if (b2Enabled && failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
