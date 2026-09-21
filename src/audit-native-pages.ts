/**
 * Shasanadesh Archive — documented pipeline file
 *
 * Pipeline stage: quality audit
 * Purpose: Flag suspicious native PDF text for selective OCR comparison.
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

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

interface PageRecord {
  sourceId: string;
  pageNumber: number;
  textSource: "native" | "ocr";
  text: string;
}

interface Metrics {
  sourceId: string;
  pageNumber: number;
  chars: number;
  devanagariChars: number;
  combiningMarks: number;
  markRatio: number;
  tokenCount: number;
  avgTokenLength: number;
  singleCharDevanagariTokens: number;
  singleCharRatio: number;
  viramaVowelAnomalies: number;
  replacementChars: number;
  score: number;
  classification: "ok" | "review" | "suspicious";
}

const documentsRoot = path.resolve("data/documents");

function countMatches(text: string, regex: RegExp): number {
  return [...text.matchAll(regex)].length;
}

function analyse(page: PageRecord): Metrics {
  const text = page.text.normalize("NFC");
  const chars = text.length;

  const devanagariChars = countMatches(text, /[\u0900-\u097F]/gu);
  const combiningMarks = countMatches(text, /\p{M}/gu);

  const tokens =
    text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

  const devTokens = tokens.filter((token) =>
    /[\u0900-\u097F]/u.test(token),
  );

  const singleCharDevanagariTokens = devTokens.filter((token) => {
    const bases = token.match(/\p{L}/gu) ?? [];
    return bases.length === 1 && token.length <= 2;
  }).length;

  const tokenCount = devTokens.length;
  const avgTokenLength =
    tokenCount > 0
      ? devTokens.reduce((sum, token) => sum + token.length, 0) / tokenCount
      : 0;

  const singleCharRatio =
    tokenCount > 0 ? singleCharDevanagariTokens / tokenCount : 0;

  const markRatio =
    devanagariChars > 0 ? combiningMarks / devanagariChars : 0;

  // A virama immediately followed by a dependent vowel sign is a common
  // symptom of broken PDF ToUnicode mappings, e.g. "्ेतन".
  const viramaVowelAnomalies = countMatches(
    text,
    /\u094D[\u093E-\u094C\u0962\u0963]/gu,
  );

  const replacementChars = countMatches(text, /\uFFFD/gu);

  let score = 100;

  if (devanagariChars >= 100) {
    if (markRatio < 0.07) score -= 25;
    else if (markRatio < 0.10) score -= 12;

    if (avgTokenLength > 0 && avgTokenLength < 2.6) score -= 20;
    else if (avgTokenLength > 0 && avgTokenLength < 3.0) score -= 10;

    score -= Math.min(30, singleCharRatio * 100);
  }

  score -= Math.min(35, viramaVowelAnomalies * 7);
  score -= Math.min(30, replacementChars * 5);

  score = Math.max(0, Math.round(score));

  const classification: Metrics["classification"] =
    score < 60 ? "suspicious" : score < 78 ? "review" : "ok";

  return {
    sourceId: page.sourceId,
    pageNumber: page.pageNumber,
    chars,
    devanagariChars,
    combiningMarks,
    markRatio,
    tokenCount,
    avgTokenLength,
    singleCharDevanagariTokens,
    singleCharRatio,
    viramaVowelAnomalies,
    replacementChars,
    score,
    classification,
  };
}

async function main() {
  const entries = await readdir(documentsRoot, { withFileTypes: true });
  const rows: Metrics[] = [];

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
      rows.push(analyse(page));
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
