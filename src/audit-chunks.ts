/**
 * Shasanadesh Archive — documented pipeline file
 *
 * Pipeline stage: quality audit
 * Purpose: Audit chunk size/distribution before indexing.
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
  text: string;
  chars: number;
}

const chunksPath = path.resolve("data/corpus/chunks.jsonl");

async function main() {
  const raw = await readFile(chunksPath, "utf8");

  const chunks = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ChunkRecord);

  const lengths = chunks.map((chunk) => chunk.chars).sort((a, b) => a - b);
  const uniqueDocuments = new Set(chunks.map((chunk) => chunk.sourceId));
  const uniquePages = new Set(
    chunks.map((chunk) => `${chunk.sourceId}#${chunk.pageNumber}`),
  );

  const percentile = (p: number): number => {
    if (lengths.length === 0) return 0;
    const index = Math.min(
      lengths.length - 1,
      Math.floor((lengths.length - 1) * p),
    );
    return lengths[index];
  };

  console.log("Chunk corpus audit");
  console.log("==================");
  console.log(`Documents: ${uniqueDocuments.size}`);
  console.log(`Pages:     ${uniquePages.size}`);
  console.log(`Chunks:    ${chunks.length}`);
  console.log(`Min chars: ${lengths[0] ?? 0}`);
  console.log(`P25 chars: ${percentile(0.25)}`);
  console.log(`P50 chars: ${percentile(0.50)}`);
  console.log(`P75 chars: ${percentile(0.75)}`);
  console.log(`P95 chars: ${percentile(0.95)}`);
  console.log(`Max chars: ${lengths[lengths.length - 1] ?? 0}`);
  console.log(
    `OCR chunks: ${chunks.filter((chunk) => chunk.textSource === "ocr").length}`,
  );
  console.log(
    `Native chunks: ${chunks.filter((chunk) => chunk.textSource === "native").length}`,
  );

  const tooSmall = chunks.filter((chunk) => chunk.chars < 120);
  const tooLarge = chunks.filter((chunk) => chunk.chars > 1900);

  console.log(`Very small (<120): ${tooSmall.length}`);
  console.log(`Very large (>1900): ${tooLarge.length}`);

  if (tooSmall.length > 0) {
    console.log("\nSmall chunk examples:");
    for (const chunk of tooSmall.slice(0, 10)) {
      console.log(`  ${chunk.chunkId} | ${chunk.chars} chars`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
