/**
 * Shasanadesh Archive — documented pipeline file
 *
 * Pipeline stage: local search
 * Purpose: Provide Unicode-safe lexical sanity-check search over chunk corpus.
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

import { readFile } from "node:fs/promises";
import path from "node:path";

interface ChunkRecord {
  chunkId: string;
  sourceId: string;
  pageNumber: number;
  chunkIndex: number;
  textSource: "native" | "ocr";
  department: string | null;
  goDate: string | null;
  goNumber: string | null;
  sourceUrl: string | null;
  text: string;
  chars: number;
  sha256: string;
}

const chunksPath = path.resolve("data/corpus/chunks.jsonl");

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("hi-IN")
    // IMPORTANT: keep Unicode combining marks (\p{M}) so Hindi matras and
    // virama are not stripped from words such as "वरिष्ठता" and "वेतन".
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function terms(value: string): string[] {
  const normalized = normalize(value);

  // Unicode-safe tokens: letters + combining marks + numbers.
  return normalized.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function countOccurrences(text: string, term: string): number {
  if (!term) return 0;

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

function score(
  query: string,
  queryTerms: string[],
  text: string,
): number {
  const normalizedText = normalize(text);
  const normalizedQuery = normalize(query);

  let value = 0;

  // Strong boost for the full phrase.
  if (normalizedQuery && normalizedText.includes(normalizedQuery)) {
    value += 20;
  }

  for (const term of queryTerms) {
    const occurrences = countOccurrences(normalizedText, term);

    // Term frequency.
    value += occurrences * 3;

    // Presence boost.
    if (occurrences > 0) {
      value += 2;
    }
  }

  // Small boost when every query term appears.
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
    console.error('Usage: npm run search -- "your query"');
    process.exit(1);
  }

  const queryTerms = terms(query);

  if (queryTerms.length === 0) {
    console.error("No searchable terms found.");
    process.exit(1);
  }

  const chunks = (await readFile(chunksPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ChunkRecord);

  const results = chunks
    .map((chunk) => ({
      chunk,
      score: score(query, queryTerms, chunk.text),
    }))
    .filter((result) => result.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.chunk.chunkId.localeCompare(b.chunk.chunkId),
    )
    .slice(0, 10);

  console.log(`Query: ${query}`);
  console.log(`Terms: ${queryTerms.join(", ")}`);
  console.log(`Matches shown: ${results.length}\n`);

  for (const result of results) {
    const { chunk } = result;
    const preview = chunk.text.replace(/\s+/g, " ").slice(0, 420);

    console.log("------------------------------------------------------------");
    console.log(
      `[score=${result.score}] ${chunk.sourceId} | page ${chunk.pageNumber} | chunk ${chunk.chunkIndex}`,
    );
    console.log(`Department: ${chunk.department ?? "(unknown)"}`);
    console.log(
      `GO: ${chunk.goNumber ?? "(unknown)"} | Date: ${chunk.goDate ?? "(unknown)"}`,
    );
    console.log(`Source: ${chunk.sourceUrl ?? "(unknown)"}`);
    console.log();
    console.log(preview);
    console.log();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
