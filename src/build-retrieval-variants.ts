/**
 * Build a dual-text retrieval corpus.
 *
 * Canonical page text remains untouched.
 *
 * For a native page with a selective OCR alternative:
 *   - keep the native variant
 *   - add the OCR variant
 *
 * Retrieval can search both variants and deduplicate by sourceId + pageNumber.
 * This lets OCR improve Hindi lexical recall without making OCR the authoritative
 * text representation.
 */

import {
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { numericTokens } from "./lib/numeric-tokens.js";

const documentsRoot = path.resolve("data/documents");
const outputPath = path.resolve(
  "data/corpus/retrieval-pages.jsonl",
);

interface PageRecord {
  sourceId: string;
  pageNumber: number;
  textSource: "native" | "ocr";
  text: string;
}

interface RetrievalPageVariant {
  variantId: string;
  sourceId: string;
  pageNumber: number;
  variant: "native" | "ocr";
  canonical: boolean;
  text: string;
  chars: number;
  numericTokens: string[];
}

function pageFile(pageNumber: number): string {
  return `page-${String(pageNumber).padStart(3, "0")}.txt`;
}

function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


async function main() {
  const entries = await readdir(documentsRoot, {
    withFileTypes: true,
  });

  const variants: RetrievalPageVariant[] = [];
  let pages = 0;
  let alternateOcrPages = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const documentDir = path.join(documentsRoot, entry.name);
    const pagesPath = path.join(documentDir, "pages.jsonl");

    let pageRecords: PageRecord[];

    try {
      pageRecords = (await readFile(pagesPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PageRecord);
    } catch {
      continue;
    }

    for (const page of pageRecords) {
      pages++;

      const canonicalText = normalizeText(page.text);

      variants.push({
        variantId: `${page.sourceId}:p${page.pageNumber}:${page.textSource}:canonical`,
        sourceId: page.sourceId,
        pageNumber: page.pageNumber,
        variant: page.textSource,
        canonical: true,
        text: canonicalText,
        chars: canonicalText.length,
        numericTokens: numericTokens(canonicalText),
      });

      // Only native pages can currently have a selective OCR alternative.
      if (page.textSource !== "native") continue;

      const selectiveOcrPath = path.join(
        documentDir,
        "ocr-selective",
        pageFile(page.pageNumber),
      );

      try {
        const ocrText = normalizeText(
          await readFile(selectiveOcrPath, "utf8"),
        );

        if (!ocrText) continue;

        alternateOcrPages++;

        variants.push({
          variantId: `${page.sourceId}:p${page.pageNumber}:ocr:alternate`,
          sourceId: page.sourceId,
          pageNumber: page.pageNumber,
          variant: "ocr",
          canonical: false,
          text: ocrText,
          chars: ocrText.length,
          numericTokens: numericTokens(ocrText),
        });
      } catch {
        // No selective OCR alternative for this page.
      }
    }
  }

  await writeFile(
    outputPath,
    variants.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );

  console.log("Retrieval page variants");
  console.log("=======================");
  console.log(`Canonical pages:       ${pages}`);
  console.log(`Alternate OCR pages:   ${alternateOcrPages}`);
  console.log(`Total page variants:   ${variants.length}`);
  console.log(`Output:                ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
