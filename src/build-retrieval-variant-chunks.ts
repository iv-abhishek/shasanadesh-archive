/**
 * Chunk canonical + alternate retrieval-page variants.
 *
 * Each chunk retains its variant identity. Search/reranking must deduplicate
 * results at the logical page boundary: sourceId + pageNumber.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describeGate, loadProcessingGate } from "./classify/processing-gate.js";

const inputPath = path.resolve(
  "data/corpus/retrieval-pages.jsonl",
);
const outputPath = path.resolve(
  "data/corpus/retrieval-variant-chunks.jsonl",
);

interface RetrievalPageVariant {
  variantId: string;
  sourceId: string;
  pageNumber: number;
  variant: "native" | "ocr";
  canonical: boolean;
  text: string;
}

interface VariantChunk {
  variantChunkId: string;
  logicalPageId: string;
  sourceId: string;
  pageNumber: number;
  variant: "native" | "ocr";
  canonical: boolean;
  chunkIndex: number;
  text: string;
  chars: number;
  sha256: string;
}

const TARGET_CHARS = 1400;
const OVERLAP_CHARS = 220;
const MIN_CHARS = 180;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function chooseBreak(
  text: string,
  start: number,
  idealEnd: number,
): number {
  const maxEnd = Math.min(text.length, idealEnd + 250);
  const minEnd = Math.min(
    text.length,
    Math.max(start + MIN_CHARS, idealEnd - 250),
  );

  for (const separator of [
    "\n\n",
    "\n",
    "।",
    ". ",
    "? ",
    "! ",
    "; ",
    ", ",
    " ",
  ]) {
    const index = text.lastIndexOf(separator, maxEnd);

    if (index >= minEnd) {
      return index + separator.length;
    }
  }

  return Math.min(text.length, idealEnd);
}

function chunk(text: string): string[] {
  if (!text) return [];
  if (text.length <= TARGET_CHARS) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const idealEnd = Math.min(text.length, start + TARGET_CHARS);
    const end =
      idealEnd === text.length
        ? text.length
        : chooseBreak(text, start, idealEnd);

    const value = text.slice(start, end).trim();

    if (value.length >= MIN_CHARS || end === text.length) {
      chunks.push(value);
    }

    if (end >= text.length) break;

    const nextStart = Math.max(0, end - OVERLAP_CHARS);
    start = nextStart <= start ? end : nextStart;
  }

  return chunks;
}

async function main() {
  const variants = (await readFile(inputPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RetrievalPageVariant);

  const chunks: VariantChunk[] = [];
  // Routine orders (tier C) are not chunked, so they are never embedded.
  const gate = loadProcessingGate();
  const routine = new Set<string>();

  for (const page of variants) {
    if (gate.skips(page.sourceId)) {
      routine.add(page.sourceId);
      continue;
    }
    chunk(page.text).forEach((text, index) => {
      chunks.push({
        variantChunkId: `${page.variantId}:c${index + 1}`,
        logicalPageId: `${page.sourceId}:p${page.pageNumber}`,
        sourceId: page.sourceId,
        pageNumber: page.pageNumber,
        variant: page.variant,
        canonical: page.canonical,
        chunkIndex: index + 1,
        text,
        chars: text.length,
        sha256: sha256(text),
      });
    });
  }

  await writeFile(
    outputPath,
    chunks.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );

  console.log("Retrieval variant chunks");
  console.log("========================");
  console.log(`Page variants: ${variants.length}`);
  console.log(`Chunks:        ${chunks.length}`);
  console.log(describeGate(gate, routine.size));
  console.log(`Output:        ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
