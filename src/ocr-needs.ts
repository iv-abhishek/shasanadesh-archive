/**
 * Shasanadesh Archive — documented pipeline file
 *
 * Pipeline stage: OCR
 * Purpose: OCR documents with insufficient native text while preserving native extraction.
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
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface Metadata {
  sourceId: string;
  department: string | null;
  pdf?: {
    pages?: number | null;
  };
  text?: {
    bytes?: number;
    hasNativeText?: boolean;
  };
  ocr?: {
    required?: boolean;
    completed?: boolean;
    engine?: string;
    languages?: string[];
    dpi?: number;
    textBytes?: number;
    textSha256?: string | null;
    normalizedTextSha256?: string | null;
    pagesProcessed?: number;
  };
}

const documentsRoot = path.resolve("data/documents");

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function ocrDocument(
  dir: string,
  metadata: Metadata,
  force: boolean,
): Promise<"ocr" | "skip" | "fail"> {
  const pdfPath = path.join(dir, "original.pdf");
  const metadataPath = path.join(dir, "metadata.json");
  const ocrTextPath = path.join(dir, "ocr.txt");
  const pagesDir = path.join(dir, "ocr-pages");

  const nativeBytes = metadata.text?.bytes ?? 0;
  const needsOcr = nativeBytes < 100 || metadata.text?.hasNativeText === false;

  if (!needsOcr) {
    return "skip";
  }

  if (!force && metadata.ocr?.completed) {
    console.log(`SKIP OCR ${metadata.sourceId} (already complete)`);
    return "skip";
  }

  console.log(`\nOCR ${metadata.sourceId}`);
  console.log(`Native text bytes: ${nativeBytes}`);

  await rm(pagesDir, { recursive: true, force: true });
  await mkdir(pagesDir, { recursive: true });

  try {
    const prefix = path.join(pagesDir, "page");

    await execFileAsync(
      "pdftoppm",
      ["-png", "-r", "300", pdfPath, prefix],
      { maxBuffer: 20 * 1024 * 1024 },
    );

    const images = (await readdir(pagesDir))
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort((a, b) => {
        const an = Number.parseInt(a.match(/\d+/)?.[0] ?? "0", 10);
        const bn = Number.parseInt(b.match(/\d+/)?.[0] ?? "0", 10);
        return an - bn;
      });

    if (images.length === 0) {
      throw new Error("pdftoppm produced no PNG pages");
    }

    const pageTexts: string[] = [];

    for (let i = 0; i < images.length; i++) {
      const imagePath = path.join(pagesDir, images[i]);
      const outputBase = path.join(pagesDir, `page-${String(i + 1).padStart(3, "0")}`);

      console.log(`  page ${i + 1}/${images.length}`);

      await execFileAsync(
        "tesseract",
        [
          imagePath,
          outputBase,
          "-l",
          "hin+eng",
          "--oem",
          "1",
          "--psm",
          "6",
          "txt",
        ],
        { maxBuffer: 20 * 1024 * 1024 },
      );

      const pageText = await readFile(`${outputBase}.txt`, "utf8");
      pageTexts.push(
        `\n\n===== PAGE ${i + 1} =====\n\n${pageText.trim()}\n`,
      );
    }

    const combined = pageTexts.join("");
    const normalized = normalizeText(combined);

    await writeFile(ocrTextPath, combined, "utf8");

    metadata.ocr = {
      required: true,
      completed: true,
      engine: "tesseract",
      languages: ["hin", "eng"],
      dpi: 300,
      textBytes: Buffer.byteLength(combined, "utf8"),
      textSha256: combined.length > 0 ? sha256(combined) : null,
      normalizedTextSha256:
        normalized.length > 0 ? sha256(normalized) : null,
      pagesProcessed: images.length,
    };

    await writeFile(
      metadataPath,
      JSON.stringify(metadata, null, 2) + "\n",
      "utf8",
    );

    console.log(
      `OK ${metadata.sourceId} | pages=${images.length} | OCR text=${metadata.ocr.textBytes} bytes`,
    );

    return "ocr";
  } catch (error) {
    console.error(
      `FAILED ${metadata.sourceId}:`,
      error instanceof Error ? error.message : String(error),
    );

    return "fail";
  }
}

async function main() {
  const force = process.argv.includes("--force");

  if (!(await commandExists("pdftoppm"))) {
    throw new Error("pdftoppm not found");
  }

  if (!(await commandExists("tesseract"))) {
    throw new Error("tesseract not found");
  }

  const entries = await readdir(documentsRoot, { withFileTypes: true });

  let ocr = 0;
  let skip = 0;
  let fail = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = path.join(documentsRoot, entry.name);
    const metadataPath = path.join(dir, "metadata.json");

    let metadata: Metadata;

    try {
      metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Metadata;
    } catch {
      continue;
    }

    const result = await ocrDocument(dir, metadata, force);

    if (result === "ocr") ocr++;
    if (result === "skip") skip++;
    if (result === "fail") fail++;
  }

  console.log("\n=================");
  console.log("OCR summary");
  console.log("=================");
  console.log(`OCR completed: ${ocr}`);
  console.log(`Skipped:       ${skip}`);
  console.log(`Failed:        ${fail}`);

  if (fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
