/**
 * Shasanadesh Archive — native page text-quality audit.
 *
 * IMPORTANT:
 * The score comes from src/lib/text-quality.ts, which is also used by selective
 * OCR comparison. Do not duplicate scoring logic in this file.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  analyzeTextQuality,
  type TextQualityMetrics,
} from "./lib/text-quality.js";

interface PageRecord {
  sourceId: string;
  pageNumber: number;
  textSource: "native" | "ocr";
  text: string;
}

interface AuditRow extends TextQualityMetrics {
  sourceId: string;
  pageNumber: number;
}

const documentsRoot = path.resolve("data/documents");

async function main() {
  const entries = await readdir(documentsRoot, { withFileTypes: true });
  const rows: AuditRow[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pagesPath = path.join(
      documentsRoot,
      entry.name,
      "pages.jsonl",
    );

    let pages: PageRecord[];

    try {
      pages = (await readFile(pagesPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PageRecord);
    } catch {
      continue;
    }

    for (const page of pages) {
      if (page.textSource !== "native") continue;

      rows.push({
        sourceId: page.sourceId,
        pageNumber: page.pageNumber,
        ...analyzeTextQuality(page.text),
      });
    }
  }

  rows.sort(
    (a, b) =>
      a.score - b.score ||
      a.sourceId.localeCompare(b.sourceId) ||
      a.pageNumber - b.pageNumber,
  );

  console.log("Native-page text quality audit");
  console.log("==============================");

  for (const row of rows) {
    if (row.classification === "ok") continue;

    console.log(
      [
        row.classification.padEnd(10),
        `score=${String(row.score).padEnd(3)}`,
        row.sourceId.padEnd(18),
        `page=${String(row.pageNumber).padEnd(3)}`,
        `dev=${String(row.devanagariChars).padEnd(5)}`,
        `marks=${(row.markRatio * 100).toFixed(1)}%`,
        `avgTok=${row.avgTokenLength.toFixed(2)}`,
        `single=${(row.singleCharRatio * 100).toFixed(1)}%`,
        `viramaVowel=${row.viramaVowelAnomalies}`,
      ].join(" | "),
    );
  }

  const suspicious = rows.filter(
    (row) => row.classification === "suspicious",
  );
  const review = rows.filter((row) => row.classification === "review");
  const ok = rows.filter((row) => row.classification === "ok");

  const affectedDocs = new Set(
    [...suspicious, ...review].map((row) => row.sourceId),
  );

  console.log("\nSummary");
  console.log("=======");
  console.log(`Native pages audited: ${rows.length}`);
  console.log(`OK:                  ${ok.length}`);
  console.log(`Review:              ${review.length}`);
  console.log(`Suspicious:          ${suspicious.length}`);
  console.log(`Affected documents:  ${affectedDocs.size}`);

  if (suspicious.length > 0) {
    console.log("\nMost suspicious pages:");
    for (const row of suspicious.slice(0, 15)) {
      console.log(
        `  ${row.sourceId} page ${row.pageNumber} | score=${row.score}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
