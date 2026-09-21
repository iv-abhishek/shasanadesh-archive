/**
 * Shasanadesh Archive — documented pipeline file
 *
 * Pipeline stage: quality audit
 * Purpose: Classify document-level native text quality.
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

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

interface Metadata {
  sourceId: string;
  department: string | null;
  pdf?: {
    pages?: number | null;
  };
  text?: {
    bytes?: number;
    hasNativeText?: boolean;
  };
}

interface AuditRow {
  sourceId: string;
  department: string | null;
  pages: number | null;
  textBytes: number;
  chars: number;
  charsPerPage: number | null;
  devanagariChars: number;
  devanagariRatio: number;
  latinChars: number;
  latinRatio: number;
  suspiciousChars: number;
  suspiciousRatio: number;
  classification:
    | "needs-ocr"
    | "sparse-text"
    | "likely-unicode-hindi"
    | "likely-english-or-mixed"
    | "suspicious-encoding";
}

const documentsRoot = path.resolve("data/documents");

function countMatches(text: string, regex: RegExp): number {
  return [...text.matchAll(regex)].length;
}

function classify(row: Omit<AuditRow, "classification">): AuditRow["classification"] {
  if (row.textBytes < 100 || row.chars < 100) {
    return "needs-ocr";
  }

  if (row.charsPerPage !== null && row.charsPerPage < 250) {
    return "sparse-text";
  }

  if (row.suspiciousRatio > 0.01) {
    return "suspicious-encoding";
  }

  if (row.devanagariRatio >= 0.15) {
    return "likely-unicode-hindi";
  }

  return "likely-english-or-mixed";
}

async function main() {
  const entries = await readdir(documentsRoot, { withFileTypes: true });
  const rows: AuditRow[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = path.join(documentsRoot, entry.name);
    const metadataPath = path.join(dir, "metadata.json");
    const textPath = path.join(dir, "text.txt");

    let metadata: Metadata;
    let text = "";

    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Metadata;
    } catch {
      continue;
    }

    try {
      text = await readFile(textPath, "utf8");
    } catch {
      text = "";
    }

    const chars = text.length;
    const textBytes = Buffer.byteLength(text, "utf8");
    const pages = metadata.pdf?.pages ?? null;

    const devanagariChars = countMatches(text, /[\u0900-\u097F]/gu);
    const latinChars = countMatches(text, /[A-Za-z]/gu);

    // Common mojibake / legacy-encoding warning characters.
    const suspiciousChars = countMatches(
      text,
      /[ÈĚØÙÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿÂÃÄÅÆÇ]/gu,
    );

    const devanagariRatio = chars > 0 ? devanagariChars / chars : 0;
    const latinRatio = chars > 0 ? latinChars / chars : 0;
    const suspiciousRatio = chars > 0 ? suspiciousChars / chars : 0;
    const charsPerPage =
      pages && pages > 0 ? Math.round(chars / pages) : null;

    const base = {
      sourceId: metadata.sourceId,
      department: metadata.department,
      pages,
      textBytes,
      chars,
      charsPerPage,
      devanagariChars,
      devanagariRatio,
      latinChars,
      latinRatio,
      suspiciousChars,
      suspiciousRatio,
    };

    rows.push({
      ...base,
      classification: classify(base),
    });
  }

  rows.sort((a, b) => {
    const order = {
      "needs-ocr": 0,
      "sparse-text": 1,
      "suspicious-encoding": 2,
      "likely-unicode-hindi": 3,
      "likely-english-or-mixed": 4,
    };

    return (
      order[a.classification] - order[b.classification] ||
      a.sourceId.localeCompare(b.sourceId)
    );
  });

  console.log("Text quality audit");
  console.log("==================");

  for (const row of rows) {
    console.log(
      [
        row.classification.padEnd(23),
        row.sourceId.padEnd(18),
        `pages=${String(row.pages ?? "?").padEnd(3)}`,
        `bytes=${String(row.textBytes).padEnd(7)}`,
        `chars/page=${String(row.charsPerPage ?? "?").padEnd(6)}`,
        `dev=${(row.devanagariRatio * 100).toFixed(1)}%`,
        `sus=${(row.suspiciousRatio * 100).toFixed(2)}%`,
      ].join(" | "),
    );
  }

  console.log("\nSummary");
  console.log("=======");

  for (const label of [
    "needs-ocr",
    "sparse-text",
    "suspicious-encoding",
    "likely-unicode-hindi",
    "likely-english-or-mixed",
  ] as const) {
    console.log(
      `${label.padEnd(23)} ${rows.filter((r) => r.classification === label).length}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
