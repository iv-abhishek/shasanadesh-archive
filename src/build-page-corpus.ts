/**
 * Shasanadesh Archive — documented pipeline file
 *
 * Pipeline stage: page corpus
 * Purpose: Build page-addressable canonical text while retaining native/OCR provenance.
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

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { decolumn, findGutter } from "./lib/columns.js";
import { promisify } from "node:util";
import type { B2CaptureStorage } from "./storage/b2.js";
import { saveDocumentMetadata } from "./storage/document-metadata.js";
import { PDFTOTEXT_BIN } from "./lib/tool-config.js";
import { describeGate, loadProcessingGate } from "./classify/processing-gate.js";
import { krutiDevToUnicode, looksLikeKrutiDev } from "./lib/krutidev.js";

const execFileAsync = promisify(execFile);
const documentsRoot = path.resolve("data/documents");

interface Metadata {
  [key: string]: unknown;
  sourceId: string;
  capture?: { captureId?: string };
  storage?: B2CaptureStorage;
  department: string | null;
  goDate?: string | null;
  goNumber?: string | null;
  sourceUrl?: string;
  pdf?: {
    pages?: number | null;
  };
  /** HTML sources (src/ingest-handbook.ts): page texts in html-pages/, no PDF. */
  html?: {
    pages?: number | null;
  };
  text?: {
    bytes?: number;
    hasNativeText?: boolean;
  };
  ocr?: {
    completed?: boolean;
    pagesProcessed?: number;
  };
  pageCorpus?: {
    completed?: boolean;
    pages?: number;
    textSource?: "native" | "ocr" | "mixed";
    /** Pages whose native text was legacy Kruti Dev and was converted to Unicode. */
    krutiDevPages?: number;
    totalTextBytes?: number;
    normalizedTextSha256?: string | null;
  };
}

interface PageRecord {
  sourceId: string;
  pageNumber: number;
  textSource: "native" | "ocr";
  /** Set when the native text was Kruti Dev and converted (src/lib/krutidev.ts). */
  converted?: "krutidev";
  text: string;
  chars: number;
  bytes: number;
  sha256: string | null;
  devanagariChars: number;
  latinChars: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function count(text: string, regex: RegExp): number {
  return [...text.matchAll(regex)].length;
}

function pageFile(pageNumber: number): string {
  return `page-${String(pageNumber).padStart(3, "0")}.txt`;
}

async function extractNativePage(
  pdfPath: string,
  pageNumber: number,
): Promise<string> {
  const { stdout } = await execFileAsync(
    PDFTOTEXT_BIN,
    [
      "-f",
      String(pageNumber),
      "-l",
      String(pageNumber),
      "-layout",
      "-enc",
      "UTF-8",
      pdfPath,
      "-",
    ],
    { maxBuffer: 20 * 1024 * 1024 },
  );

  return stdout;
}

async function readOcrPage(
  documentDir: string,
  pageNumber: number,
): Promise<string | null> {
  const ocrPath = path.join(
    documentDir,
    "ocr-pages",
    pageFile(pageNumber),
  );

  try {
    return await readFile(ocrPath, "utf8");
  } catch {
    return null;
  }
}

async function readHtmlPage(
  documentDir: string,
  pageNumber: number,
): Promise<string> {
  return readFile(path.join(documentDir, "html-pages", pageFile(pageNumber)), "utf8");
}

async function buildForDocument(
  documentDir: string,
  metadata: Metadata,
): Promise<"built" | "skipped" | "failed"> {
  const fromHtml = Boolean(metadata.html?.pages);
  const pages = (fromHtml ? metadata.html?.pages : metadata.pdf?.pages) ?? 0;

  if (!pages || pages < 1) {
    console.log(`SKIP ${metadata.sourceId}: page count unavailable`);
    return "skipped";
  }

  const pdfPath = path.join(documentDir, "original.pdf");
  const metadataPath = path.join(documentDir, "metadata.json");
  const pagesDir = path.join(documentDir, "pages");
  const jsonlPath = path.join(documentDir, "pages.jsonl");
  const canonicalPath = path.join(documentDir, "content.txt");

  await rm(pagesDir, { recursive: true, force: true });
  await mkdir(pagesDir, { recursive: true });

  const records: PageRecord[] = [];
  const canonicalPages: string[] = [];
  const usedSources = new Set<"native" | "ocr">();
  let krutiDevPages = 0;

  console.log(`\nBUILD ${metadata.sourceId} (${pages} pages)`);

  try {
    // HTML sources are already text (one file per page); PDFs go through pdftotext.
    const nativeRaws: string[] = [];
    for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
      nativeRaws.push(fromHtml ? await readHtmlPage(documentDir, pageNumber) : await extractNativePage(pdfPath, pageNumber));
    }
    // Two-column documents (GFR 2017) read column by column instead of
    // interleaved line by line. Decided per document: only when at least 40%
    // of its pages have a gutter, so a few table pages in a one-column
    // document (delegation schedules) keep their rows (ADR-085).
    const columnPages = fromHtml ? 0 : nativeRaws.filter((raw) => findGutter(raw) !== null).length;
    const twoColumnDocument = !fromHtml && pages >= 3 && columnPages >= pages * 0.4;

    for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
      const nativeRaw = twoColumnDocument ? decolumn(nativeRaws[pageNumber - 1]) : nativeRaws[pageNumber - 1];
      let native = normalizeText(nativeRaw);
      // Legacy Kruti Dev text ("foŸkh; vf/kdkj") is converted exactly to
      // Unicode Hindi; it stays the native variant.
      const converted = looksLikeKrutiDev(native);
      if (converted) {
        native = normalizeText(krutiDevToUnicode(native));
        krutiDevPages++;
      }

      let text = native;
      let textSource: "native" | "ocr" = "native";

      // If the native page has almost no text and OCR exists, use OCR.
      if (native.length < 80 && metadata.ocr?.completed) {
        const ocrRaw = await readOcrPage(documentDir, pageNumber);
        const ocr = ocrRaw ? normalizeText(ocrRaw) : "";

        if (ocr.length > native.length) {
          text = ocr;
          textSource = "ocr";
        }
      }

      usedSources.add(textSource);

      const pagePath = path.join(pagesDir, pageFile(pageNumber));
      await writeFile(pagePath, text + "\n", "utf8");

      const record: PageRecord = {
        sourceId: metadata.sourceId,
        pageNumber,
        textSource,
        ...(converted && textSource === "native" ? { converted: "krutidev" as const } : {}),
        text,
        chars: text.length,
        bytes: Buffer.byteLength(text, "utf8"),
        sha256: text.length > 0 ? sha256(text) : null,
        devanagariChars: count(text, /[\u0900-\u097F]/gu),
        latinChars: count(text, /[A-Za-z]/gu),
      };

      records.push(record);

      canonicalPages.push(
        `===== PAGE ${pageNumber} =====\n${text}\n`,
      );

      console.log(
        `  page ${pageNumber}/${pages}: ${textSource}, ${record.chars} chars`,
      );
    }

    const jsonl =
      records.map((record) => JSON.stringify(record)).join("\n") + "\n";

    const canonicalText = canonicalPages.join("\n");
    const normalizedCanonical = normalizeText(canonicalText);

    await writeFile(jsonlPath, jsonl, "utf8");
    await writeFile(canonicalPath, canonicalText, "utf8");

    const textSource: "native" | "ocr" | "mixed" =
      usedSources.size === 1
        ? [...usedSources][0]
        : "mixed";

    metadata.pageCorpus = {
      completed: true,
      pages: records.length,
      textSource,
      ...(krutiDevPages ? { krutiDevPages } : {}),
      totalTextBytes: Buffer.byteLength(canonicalText, "utf8"),
      normalizedTextSha256:
        normalizedCanonical.length > 0
          ? sha256(normalizedCanonical)
          : null,
    };

    await saveDocumentMetadata(metadataPath, metadata);

    console.log(
      `OK ${metadata.sourceId} | source=${textSource} | ${records.length} pages`,
    );

    return "built";
  } catch (error) {
    console.error(
      `FAILED ${metadata.sourceId}:`,
      error instanceof Error ? error.message : String(error),
    );

    return "failed";
  }
}

function requestedSourceId(): string | undefined {
  const index = process.argv.indexOf("--source-id");
  if (index < 0) return undefined;
  const sourceId = process.argv[index + 1]?.trim();
  if (!sourceId || sourceId.startsWith("--")) {
    throw new Error("--source-id needs a document source ID.");
  }
  return sourceId;
}

async function main() {
  const sourceId = requestedSourceId();
  const entries = await readdir(documentsRoot, { withFileTypes: true });

  let built = 0;
  let skipped = 0;
  let failed = 0;
  let matched = false;
  // Routine orders (tier C) are not split into pages: nothing downstream uses
  // them, and each rebuild would also refresh the B2 manifest. An explicit
  // --source-id is always built.
  const gate = loadProcessingGate();
  let routine = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const documentDir = path.join(documentsRoot, entry.name);
    const metadataPath = path.join(documentDir, "metadata.json");

    let metadata: Metadata;

    try {
      metadata = JSON.parse(
        await readFile(metadataPath, "utf8"),
      ) as Metadata;
    } catch {
      continue;
    }

    if (sourceId && metadata.sourceId !== sourceId) continue;
    matched = true;
    if (!sourceId && gate.skips(metadata.sourceId)) {
      routine++;
      continue;
    }
    // A crawled copy of an order already in the archive (ADR-103): cite the archived one.
    if (!sourceId && (metadata as { duplicateOf?: unknown }).duplicateOf) {
      routine++;
      continue;
    }

    const result = await buildForDocument(documentDir, metadata);

    if (result === "built") built++;
    if (result === "skipped") skipped++;
    if (result === "failed") failed++;
  }

  if (sourceId && !matched) {
    throw new Error("No archived document matched source ID " + sourceId);
  }

  console.log("\n========================");
  console.log("Page corpus summary");
  console.log("========================");
  console.log(`Built:   ${built}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed:  ${failed}`);
  console.log(describeGate(gate, routine));

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
