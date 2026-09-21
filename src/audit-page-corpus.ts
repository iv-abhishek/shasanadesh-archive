/**
 * Shasanadesh Archive — documented pipeline file
 *
 * Pipeline stage: quality audit
 * Purpose: Audit page-corpus coverage and text-source selection.
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

interface Metadata {
  sourceId: string;
  pageCorpus?: {
    completed?: boolean;
    pages?: number;
    textSource?: "native" | "ocr" | "mixed";
    totalTextBytes?: number;
  };
}

const documentsRoot = path.resolve("data/documents");

async function main() {
  const entries = await readdir(documentsRoot, { withFileTypes: true });

  let documents = 0;
  let pages = 0;
  let nativeDocs = 0;
  let ocrDocs = 0;
  let mixedDocs = 0;

  console.log("Page corpus audit");
  console.log("=================");

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const metadataPath = path.join(
      documentsRoot,
      entry.name,
      "metadata.json",
    );

    let metadata: Metadata;

    try {
      metadata = JSON.parse(
        await readFile(metadataPath, "utf8"),
      ) as Metadata;
    } catch {
      continue;
    }

    if (!metadata.pageCorpus?.completed) continue;

    documents++;
    pages += metadata.pageCorpus.pages ?? 0;

    if (metadata.pageCorpus.textSource === "native") nativeDocs++;
    if (metadata.pageCorpus.textSource === "ocr") ocrDocs++;
    if (metadata.pageCorpus.textSource === "mixed") mixedDocs++;

    console.log(
      [
        metadata.sourceId.padEnd(18),
        `pages=${String(metadata.pageCorpus.pages ?? "?").padEnd(3)}`,
        `source=${String(metadata.pageCorpus.textSource ?? "?").padEnd(6)}`,
        `bytes=${metadata.pageCorpus.totalTextBytes ?? 0}`,
      ].join(" | "),
    );
  }

  console.log("\nSummary");
  console.log("=======");
  console.log(`Documents: ${documents}`);
  console.log(`Pages:     ${pages}`);
  console.log(`Native:    ${nativeDocs}`);
  console.log(`OCR:       ${ocrDocs}`);
  console.log(`Mixed:     ${mixedDocs}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
