/**
 * Audit native-vs-selective-OCR disagreements that matter for government orders.
 *
 * OCR can make Hindi prose much more readable while corrupting dates, amounts,
 * rule numbers, GO numbers, page numbers, percentages, etc. This audit measures
 * those numeric-token disagreements so OCR quality is not confused with factual
 * fidelity.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { numericTokens } from "./lib/numeric-tokens.js";

interface ComparisonRecord {
  sourceId: string;
  pageNumber: number;
  nativePreview: string;
  ocrPreview: string;
  native: { score: number };
  ocr: { score: number };
}

const reportPath = path.resolve(
  "data/corpus/selective-ocr-report.jsonl",
);


function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function main() {
  const raw = await readFile(reportPath, "utf8");

  const rows = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ComparisonRecord);

  console.log("Selective OCR numeric/identifier conflict audit");
  console.log("==============================================");

  let conflictPages = 0;

  for (const row of rows) {
    const native = unique(numericTokens(row.nativePreview));
    const ocr = unique(numericTokens(row.ocrPreview));

    const nativeOnly = native.filter((token) => !ocr.includes(token));
    const ocrOnly = ocr.filter((token) => !native.includes(token));

    const hasConflict = nativeOnly.length > 0 || ocrOnly.length > 0;

    if (!hasConflict) continue;

    conflictPages++;

    console.log();
    console.log(`${row.sourceId} | page ${row.pageNumber}`);
    console.log(`quality native=${row.native.score} ocr=${row.ocr.score}`);
    console.log(`native numbers: ${native.join(", ") || "(none)"}`);
    console.log(`ocr numbers:    ${ocr.join(", ") || "(none)"}`);
    console.log(`native-only:    ${nativeOnly.join(", ") || "(none)"}`);
    console.log(`ocr-only:       ${ocrOnly.join(", ") || "(none)"}`);
  }

  console.log("\nSummary");
  console.log("=======");
  console.log(`Compared pages: ${rows.length}`);
  console.log(`Pages with numeric-token disagreement: ${conflictPages}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
