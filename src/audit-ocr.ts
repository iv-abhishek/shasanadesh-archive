import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

interface Metadata {
  sourceId: string;
  department: string | null;
  ocr?: {
    completed?: boolean;
    textBytes?: number;
    pagesProcessed?: number;
  };
}

const documentsRoot = path.resolve("data/documents");

function count(text: string, regex: RegExp): number {
  return [...text.matchAll(regex)].length;
}

async function main() {
  const entries = await readdir(documentsRoot, { withFileTypes: true });

  console.log("OCR quality audit");
  console.log("=================");

  let found = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = path.join(documentsRoot, entry.name);

    let metadata: Metadata;

    try {
      metadata = JSON.parse(
        await readFile(path.join(dir, "metadata.json"), "utf8"),
      ) as Metadata;
    } catch {
      continue;
    }

    if (!metadata.ocr?.completed) continue;

    let text = "";

    try {
      text = await readFile(path.join(dir, "ocr.txt"), "utf8");
    } catch {
      continue;
    }

    found++;

    const chars = text.length;
    const devanagari = count(text, /[\u0900-\u097F]/gu);
    const latin = count(text, /[A-Za-z]/gu);

    const devRatio = chars > 0 ? devanagari / chars : 0;
    const latinRatio = chars > 0 ? latin / chars : 0;

    console.log(
      [
        metadata.sourceId.padEnd(18),
        `pages=${String(metadata.ocr.pagesProcessed ?? "?").padEnd(3)}`,
        `bytes=${String(metadata.ocr.textBytes ?? 0).padEnd(7)}`,
        `dev=${(devRatio * 100).toFixed(1)}%`,
        `latin=${(latinRatio * 100).toFixed(1)}%`,
      ].join(" | "),
    );
  }

  console.log(`\nOCR documents audited: ${found}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
