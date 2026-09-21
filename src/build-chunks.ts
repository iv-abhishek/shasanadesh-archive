/**
 * Shasanadesh Archive — documented pipeline file
 *
 * Pipeline stage: chunking
 * Purpose: Build page-bound retrieval chunks with stable citation metadata.
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
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const documentsRoot = path.resolve("data/documents");
const corpusRoot = path.resolve("data/corpus");

interface Metadata {
  sourceId: string;
  encodedId?: string;
  sourceUrl?: string;
  department?: string | null;
  goDate?: string | null;
  goNumber?: string | null;
}

interface PageRecord {
  sourceId: string;
  pageNumber: number;
  textSource: "native" | "ocr";
  text: string;
  chars: number;
  bytes: number;
  sha256: string | null;
}

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

const TARGET_CHARS = 1400;
const OVERLAP_CHARS = 220;
const MIN_CHARS = 180;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chooseBreak(text: string, start: number, idealEnd: number): number {
  const maxEnd = Math.min(text.length, idealEnd + 250);
  const minEnd = Math.min(text.length, Math.max(start + MIN_CHARS, idealEnd - 250));

  const candidates = [
    "\n\n",
    "\n",
    "।",
    ". ",
    "? ",
    "! ",
    "; ",
    ", ",
    " ",
  ];

  for (const separator of candidates) {
    const index = text.lastIndexOf(separator, maxEnd);

    if (index >= minEnd) {
      return index + separator.length;
    }
  }

  return Math.min(text.length, idealEnd);
}

function splitIntoChunks(text: string): string[] {
  const normalized = normalizeWhitespace(text);

  if (!normalized) return [];
  if (normalized.length <= TARGET_CHARS) return [normalized];

  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    const idealEnd = Math.min(normalized.length, start + TARGET_CHARS);
    const end =
      idealEnd === normalized.length
        ? normalized.length
        : chooseBreak(normalized, start, idealEnd);

    const chunk = normalized.slice(start, end).trim();

    if (chunk.length >= MIN_CHARS || end === normalized.length) {
      chunks.push(chunk);
    }

    if (end >= normalized.length) break;

    const nextStart = Math.max(0, end - OVERLAP_CHARS);

    // Ensure forward progress even for pathological text.
    start = nextStart <= start ? end : nextStart;
  }

  return chunks;
}

async function main() {
  await mkdir(corpusRoot, { recursive: true });

  const entries = await readdir(documentsRoot, { withFileTypes: true });
  const allChunks: ChunkRecord[] = [];

  let documents = 0;
  let pages = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const documentDir = path.join(documentsRoot, entry.name);
    const metadataPath = path.join(documentDir, "metadata.json");
    const pagesPath = path.join(documentDir, "pages.jsonl");
    const chunksPath = path.join(documentDir, "chunks.jsonl");

    let metadata: Metadata;
    let pageRecords: PageRecord[];

    try {
      metadata = JSON.parse(
        await readFile(metadataPath, "utf8"),
      ) as Metadata;

      pageRecords = (await readFile(pagesPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PageRecord);
    } catch {
      continue;
    }

    const documentChunks: ChunkRecord[] = [];

    for (const page of pageRecords) {
      pages++;

      const texts = splitIntoChunks(page.text);

      texts.forEach((text, index) => {
        const chunkId = `${metadata.sourceId}:p${page.pageNumber}:c${index + 1}`;

        documentChunks.push({
          chunkId,
          sourceId: metadata.sourceId,
          pageNumber: page.pageNumber,
          chunkIndex: index + 1,
          textSource: page.textSource,
          department: metadata.department ?? null,
          goDate: metadata.goDate ?? null,
          goNumber: metadata.goNumber ?? null,
          sourceUrl: metadata.sourceUrl ?? null,
          text,
          chars: text.length,
          sha256: sha256(text),
        });
      });
    }

    if (documentChunks.length === 0) continue;

    documents++;
    allChunks.push(...documentChunks);

    await writeFile(
      chunksPath,
      documentChunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n",
      "utf8",
    );

    console.log(
      `BUILT ${metadata.sourceId} | pages=${pageRecords.length} | chunks=${documentChunks.length}`,
    );
  }

  const globalPath = path.join(corpusRoot, "chunks.jsonl");

  await writeFile(
    globalPath,
    allChunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n",
    "utf8",
  );

  console.log("\n====================");
  console.log("Chunk corpus summary");
  console.log("====================");
  console.log(`Documents: ${documents}`);
  console.log(`Pages:     ${pages}`);
  console.log(`Chunks:    ${allChunks.length}`);
  console.log(`Global:    ${globalPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
