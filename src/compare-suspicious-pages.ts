/**
 * Shasanadesh Archive — selective OCR comparison.
 *
 * Re-render only suspicious native-text pages, OCR them, and compare both
 * representations using the SAME quality function as audit:native-pages.
 *
 * This tool never replaces canonical page text automatically.
 */

import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  OCR_DPI,
  OCR_LANGS,
  PDFTOPPM_BIN,
  TESSERACT_BIN,
} from "./lib/tool-config.js";
import { promisify } from "node:util";
import {
  analyzeTextQuality,
  normalizeText,
  type TextQualityMetrics,
} from "./lib/text-quality.js";
import { describeGate, loadProcessingGate } from "./classify/processing-gate.js";

const execFileAsync = promisify(execFile);
const documentsRoot = path.resolve("data/documents");
const reportPath = path.resolve(
  "data/corpus/selective-ocr-report.jsonl",
);

interface PageRecord {
  sourceId: string;
  pageNumber: number;
  textSource: "native" | "ocr";
  text: string;
}

interface ComparisonRecord {
  sourceId: string;
  pageNumber: number;
  native: TextQualityMetrics;
  ocr: TextQualityMetrics;
  nativePreview: string;
  ocrPreview: string;
  recommendation: "prefer-native" | "prefer-ocr" | "manual-review";
  scoreDelta: number;
  ocrTextPath: string;
}

function getNumberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);

  if (index === -1) return fallback;

  const value = Number.parseInt(process.argv[index + 1] ?? "", 10);

  if (!Number.isFinite(value)) {
    throw new Error(`Invalid --${name}`);
  }

  return value;
}

function recommend(
  native: TextQualityMetrics,
  ocr: TextQualityMetrics,
): ComparisonRecord["recommendation"] {
  const delta = ocr.score - native.score;

  // Be conservative: only make a recommendation when one representation is
  // substantially better under the same triage metric.
  if (
    delta >= 15 &&
    ocr.chars >= Math.min(200, native.chars * 0.5)
  ) {
    return "prefer-ocr";
  }

  if (delta <= -15) {
    return "prefer-native";
  }

  return "manual-review";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function renderAndOcrPage(
  documentDir: string,
  sourceId: string,
  pageNumber: number,
): Promise<{ text: string; textPath: string }> {
  const pdfPath = path.join(documentDir, "original.pdf");
  const outDir = path.join(documentDir, "ocr-selective");

  await mkdir(outDir, { recursive: true });

  const stem = `page-${String(pageNumber).padStart(3, "0")}`;
  const renderBase = path.join(outDir, `${stem}-render`);
  const pngPath = `${renderBase}.png`;
  const ocrBase = path.join(outDir, stem);
  const textPath = `${ocrBase}.txt`;

  await execFileAsync(
    PDFTOPPM_BIN,
    [
      "-f",
      String(pageNumber),
      "-l",
      String(pageNumber),
      "-singlefile",
      "-png",
      "-r",
      String(OCR_DPI),
      pdfPath,
      renderBase,
    ],
    { maxBuffer: 20 * 1024 * 1024 },
  );

  await execFileAsync(
    TESSERACT_BIN,
    [
      pngPath,
      ocrBase,
      "-l",
      OCR_LANGS,
      "--oem",
      "1",
      "--psm",
      "6",
      "txt",
    ],
    { maxBuffer: 20 * 1024 * 1024 },
  );

  const text = await readFile(textPath, "utf8");

  // Keep OCR text for auditability; discard only the temporary rendered image.
  await rm(pngPath, { force: true });

  console.log(`  OCR ${sourceId} page ${pageNumber}`);

  return { text, textPath };
}

async function main() {
  const maxPages = getNumberArg("max", 12);
  const threshold = getNumberArg("threshold", 55);
  // By default pages that already have a selective OCR file are skipped, so
  // repeated runs work through the backlog instead of redoing the worst pages.
  const redo = process.argv.includes("--redo");

  if (maxPages < 1 || maxPages > 500) {
    throw new Error("--max must be between 1 and 500");
  }

  const entries = await readdir(documentsRoot, {
    withFileTypes: true,
  });

  let alreadyDone = 0;
  const gate = loadProcessingGate();
  const routine = new Set<string>();
  const candidates: Array<{
    documentDir: string;
    page: PageRecord;
    native: TextQualityMetrics;
  }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const documentDir = path.join(documentsRoot, entry.name);
    const pagesPath = path.join(documentDir, "pages.jsonl");

    let pages: PageRecord[];

    try {
      pages = (await readFile(pagesPath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PageRecord);
    } catch {
      continue;
    }

    for (const page of pages) {
      if (page.textSource !== "native") continue;
      if (gate.skips(page.sourceId)) {
        routine.add(page.sourceId);
        continue;
      }

      const native = analyzeTextQuality(page.text);

      if (
        !redo &&
        (await fileExists(
          path.join(
            documentDir,
            "ocr-selective",
            `page-${String(page.pageNumber).padStart(3, "0")}.txt`,
          ),
        ))
      ) {
        alreadyDone++;
        continue;
      }

      if (native.score <= threshold) {
        candidates.push({
          documentDir,
          page,
          native,
        });
      }
    }
  }

  candidates.sort(
    (a, b) =>
      a.native.score - b.native.score ||
      a.page.sourceId.localeCompare(b.page.sourceId) ||
      a.page.pageNumber - b.page.pageNumber,
  );

  const selected = candidates.slice(0, maxPages);

  console.log("Selective OCR comparison");
  console.log("========================");
  console.log(`Threshold:       <= ${threshold}`);
  console.log(`Already OCR'd:   ${alreadyDone}${redo ? "" : " (skipped; pass --redo to include)"}`);
  console.log(describeGate(gate, routine.size));
  console.log(`Candidates:      ${candidates.length}`);
  console.log(`Selected pages:  ${selected.length}`);
  console.log();

  const comparisons: ComparisonRecord[] = [];

  for (const candidate of selected) {
    const { documentDir, page, native } = candidate;

    try {
      const ocrResult = await renderAndOcrPage(
        documentDir,
        page.sourceId,
        page.pageNumber,
      );

      const ocr = analyzeTextQuality(ocrResult.text);
      const recommendation = recommend(native, ocr);

      const record: ComparisonRecord = {
        sourceId: page.sourceId,
        pageNumber: page.pageNumber,
        native,
        ocr,
        nativePreview: normalizeText(page.text).slice(0, 300),
        ocrPreview: normalizeText(ocrResult.text).slice(0, 300),
        recommendation,
        scoreDelta: ocr.score - native.score,
        ocrTextPath: ocrResult.textPath,
      };

      comparisons.push(record);

      console.log(
        [
          `    native=${native.score}`,
          `ocr=${ocr.score}`,
          `delta=${record.scoreDelta}`,
          recommendation,
        ].join(" | "),
      );
    } catch (error) {
      console.error(
        `FAILED ${page.sourceId} page ${page.pageNumber}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Merge with earlier runs so the report covers every page ever compared.
  const merged = new Map<string, ComparisonRecord>();

  try {
    for (const line of (await readFile(reportPath, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as ComparisonRecord;
      merged.set(`${record.sourceId}#${record.pageNumber}`, record);
    }
  } catch {
    // No earlier report.
  }

  for (const record of comparisons) {
    merged.set(`${record.sourceId}#${record.pageNumber}`, record);
  }

  const reportRows = [...merged.values()].sort(
    (a, b) =>
      a.sourceId.localeCompare(b.sourceId) || a.pageNumber - b.pageNumber,
  );

  await writeFile(
    reportPath,
    reportRows.map((record) => JSON.stringify(record)).join("\n") +
      (reportRows.length ? "\n" : ""),
    "utf8",
  );

  console.log("\nSummary");
  console.log("=======");
  console.log(`Compared:       ${comparisons.length}`);
  console.log(
    `Prefer OCR:     ${comparisons.filter((r) => r.recommendation === "prefer-ocr").length}`,
  );
  console.log(
    `Prefer native:  ${comparisons.filter((r) => r.recommendation === "prefer-native").length}`,
  );
  console.log(
    `Manual review:  ${comparisons.filter((r) => r.recommendation === "manual-review").length}`,
  );
  console.log(`Report:         ${reportPath} (${reportRows.length} pages total)`);
  if (candidates.length > selected.length) {
    console.log(
      `Remaining:      ${candidates.length - selected.length} candidate pages; run again to continue.`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
