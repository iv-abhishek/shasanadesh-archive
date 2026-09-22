/**
 * Shasanadesh Archive — selective OCR report audit
 *
 * Purpose:
 *   Print the OCR-vs-native comparison report in a compact form so we can
 *   inspect whether the heuristic is useful before changing canonical text.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

interface ComparisonRecord {
  sourceId: string;
  pageNumber: number;
  native: {
    score: number;
    chars: number;
    viramaVowelAnomalies: number;
    singleCharRatio: number;
  };
  ocr: {
    score: number;
    chars: number;
    viramaVowelAnomalies: number;
    singleCharRatio: number;
  };
  recommendation:
    | "prefer-native"
    | "prefer-ocr"
    | "manual-review";
  scoreDelta: number;
  nativePreview: string;
  ocrPreview: string;
}

const reportPath = path.resolve(
  "data/corpus/selective-ocr-report.jsonl",
);

async function main() {
  const raw = await readFile(reportPath, "utf8");

  const rows = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ComparisonRecord)
    .sort(
      (a, b) =>
        b.scoreDelta - a.scoreDelta ||
        a.sourceId.localeCompare(b.sourceId) ||
        a.pageNumber - b.pageNumber,
    );

  console.log("Selective OCR audit");
  console.log("===================");

  for (const row of rows) {
    console.log();
    console.log(
      `${row.sourceId} | page ${row.pageNumber} | ${row.recommendation}`,
    );
    console.log(
      `native=${row.native.score} (${row.native.chars} chars) | ` +
        `ocr=${row.ocr.score} (${row.ocr.chars} chars) | ` +
        `delta=${row.scoreDelta}`,
    );
    console.log(
      `virama-vowel native=${row.native.viramaVowelAnomalies} ` +
        `ocr=${row.ocr.viramaVowelAnomalies}`,
    );
    console.log(`NATIVE: ${row.nativePreview}`);
    console.log(`OCR:    ${row.ocrPreview}`);
  }

  console.log("\nSummary");
  console.log("=======");
  console.log(`Compared: ${rows.length}`);
  console.log(
    `Prefer OCR: ${rows.filter((row) => row.recommendation === "prefer-ocr").length}`,
  );
  console.log(
    `Prefer native: ${rows.filter((row) => row.recommendation === "prefer-native").length}`,
  );
  console.log(
    `Manual review: ${rows.filter((row) => row.recommendation === "manual-review").length}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
