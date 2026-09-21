#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f package.json ]]; then
  echo "Run this from the shasanadesh project root."
  exit 1
fi

mkdir -p src data/corpus

cat > src/build-chunks.ts <<'EOF'
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
EOF

cat > src/audit-chunks.ts <<'EOF'
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
EOF

cat > src/search-chunks.ts <<'EOF'
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
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function terms(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((term) => term.length >= 2);
}

function score(queryTerms: string[], text: string): number {
  const normalizedText = normalize(text);
  let score = 0;

  for (const term of queryTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = normalizedText.match(new RegExp(escaped, "gu"));
    score += (matches?.length ?? 0) * 2;

    if (normalizedText.includes(term)) {
      score += 1;
    }
  }

  return score;
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
      score: score(queryTerms, chunk.text),
    }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId))
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
    console.log(`GO: ${chunk.goNumber ?? "(unknown)"} | Date: ${chunk.goDate ?? "(unknown)"}`);
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
EOF

npm pkg set scripts.build:chunks="tsx src/build-chunks.ts" >/dev/null
npm pkg set scripts.audit:chunks="tsx src/audit-chunks.ts" >/dev/null
npm pkg set scripts.search="tsx src/search-chunks.ts" >/dev/null

echo
echo "Added:"
echo "  src/build-chunks.ts"
echo "  src/audit-chunks.ts"
echo "  src/search-chunks.ts"
echo
echo "Run:"
echo "  npx tsc --noEmit"
echo "  npm run build:chunks"
echo "  npm run audit:chunks"
echo
echo "Then try:"
echo '  npm run search -- "वरिष्ठता"'
echo '  npm run search -- "वेतन आयोग"'
echo '  npm run search -- "medical officer"'
