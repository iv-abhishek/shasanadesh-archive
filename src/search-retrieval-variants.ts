/**
 * Experimental lexical search across native + OCR variants.
 *
 * Multiple variants of the same source page compete during search, but final
 * output is deduplicated by logical page so one page cannot occupy many result
 * slots just because it has multiple extraction variants.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const chunksPath = path.resolve(
  "data/corpus/retrieval-variant-chunks.jsonl",
);

interface VariantChunk {
  variantChunkId: string;
  logicalPageId: string;
  sourceId: string;
  pageNumber: number;
  variant: "native" | "ocr";
  canonical: boolean;
  chunkIndex: number;
  text: string;
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("hi-IN")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function terms(value: string): string[] {
  return normalize(value).match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function occurrences(text: string, term: string): number {
  let count = 0;
  let offset = 0;

  while (true) {
    const index = text.indexOf(term, offset);
    if (index === -1) break;

    count++;
    offset = index + term.length;
  }

  return count;
}

function score(query: string, queryTerms: string[], text: string): number {
  const normalizedText = normalize(text);
  const normalizedQuery = normalize(query);

  let value = normalizedText.includes(normalizedQuery) ? 20 : 0;

  for (const term of queryTerms) {
    const count = occurrences(normalizedText, term);
    value += count * 3;
    if (count > 0) value += 2;
  }

  if (
    queryTerms.length > 1 &&
    queryTerms.every((term) => normalizedText.includes(term))
  ) {
    value += 8;
  }

  return value;
}

async function main() {
  const query = process.argv.slice(2).join(" ").trim();

  if (!query) {
    console.error('Usage: npm run search:variants -- "query"');
    process.exit(1);
  }

  const queryTerms = terms(query);
  const chunks = (await readFile(chunksPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as VariantChunk);

  const ranked = chunks
    .map((chunk) => ({
      chunk,
      score: score(query, queryTerms, chunk.text),
    }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.chunk.canonical) - Number(a.chunk.canonical),
    );

  // Deduplicate by logical source page after variants compete.
  const selected = new Map<
    string,
    { chunk: VariantChunk; score: number }
  >();

  for (const row of ranked) {
    if (!selected.has(row.chunk.logicalPageId)) {
      selected.set(row.chunk.logicalPageId, row);
    }

    if (selected.size >= 10) break;
  }

  console.log(`Query: ${query}`);
  console.log(`Terms: ${queryTerms.join(", ")}`);
  console.log();

  for (const { chunk, score } of selected.values()) {
    console.log("------------------------------------------------------------");
    console.log(
      `[score=${score}] ${chunk.sourceId} | page ${chunk.pageNumber} | ${chunk.variant}${chunk.canonical ? " (canonical)" : " (alternate)"}`,
    );
    console.log(chunk.text.replace(/\s+/g, " ").slice(0, 500));
    console.log();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
