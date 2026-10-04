/**
 * Pipeline stage: OCR on a rented GPU with PaddleOCR-VL (ADR-104)
 *
 * Purpose:
 *   Tesseract garbles tables, amounts and conjuncts in scanned Hindi GOs, and a
 *   misread page can never be found by search. PaddleOCR-VL (0.9B, Devanagari)
 *   reads them far better but needs a GPU, so scans go out in a batch and the
 *   text comes back:
 *
 *     npm run ocr:export -- --limit 20            pick scanned documents → data/ocr-batch/<name>/
 *     (GPU) python train/ocr_paddle.py --batch <folder>
 *     npm run ocr:import -- data/ocr-batch/<name>  write the text back, keep Tesseract's for comparison
 *     npm run sync:daily                           rebuild pages and search for those documents
 *
 * Invariants:
 *   - Tesseract's pages are kept in ocr-pages-tesseract/ and its metadata under
 *     ocr.previous, so a worse result can be rolled back (--rollback)
 *   - only documents the processing gate keeps (tiers A/B) unless --all
 *   - a comparison report (first lines of each engine) is written on import
 */

import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { loadProcessingGate } from "../classify/processing-gate.js";
import { saveDocumentMetadata } from "../storage/document-metadata.js";

const ROOT = path.resolve("data/documents");
const BATCHES = path.resolve("data/ocr-batch");

interface ManifestRow {
  dir: string;
  sourceId: string;
  pages: number | null;
  previousEngine: string | null;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function pageFile(pageNumber: number): string {
  return `page-${String(pageNumber).padStart(3, "0")}.txt`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Split the GPU's per-document text ("===== PAGE n =====" blocks) into pages. */
export function splitPages(combined: string): Map<number, string> {
  const pages = new Map<number, string>();
  const parts = combined.split(/^===== PAGE (\d+) =====$/m);
  for (let index = 1; index < parts.length; index += 2) pages.set(Number(parts[index]), parts[index + 1].trim());
  return pages;
}

async function exportBatch(): Promise<void> {
  const limit = Number(option("--limit") ?? 200);
  const all = process.argv.includes("--all");
  const name = option("--name") ?? `batch-${new Date().toISOString().slice(0, 10)}`;
  const folder = path.join(BATCHES, name);
  await mkdir(path.join(folder, "pdfs"), { recursive: true });
  const gate = loadProcessingGate([]);
  const picked: ManifestRow[] = [];
  for (const entry of await readdir(ROOT, { withFileTypes: true })) {
    if (picked.length >= limit) break;
    if (!entry.isDirectory()) continue;
    const dir = path.join(ROOT, entry.name);
    let metadata: Record<string, any>;
    try {
      metadata = JSON.parse(await readFile(path.join(dir, "metadata.json"), "utf8"));
    } catch {
      continue;
    }
    const scanned = (metadata.text?.bytes ?? 0) < 100 || metadata.text?.hasNativeText === false;
    if (!scanned || metadata.ocr?.engine === "paddleocr-vl" || metadata.duplicateOf) continue;
    if (!all && gate.skips(metadata.sourceId)) continue;
    await copyFile(path.join(dir, "original.pdf"), path.join(folder, "pdfs", `${entry.name}.pdf`)).catch(() => null);
    picked.push({ dir: entry.name, sourceId: metadata.sourceId, pages: metadata.pdf?.pages ?? null, previousEngine: metadata.ocr?.engine ?? null });
  }
  await writeFile(path.join(folder, "manifest.jsonl"), picked.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const pages = picked.reduce((sum, row) => sum + (row.pages ?? 0), 0);
  console.log(`${picked.length} scanned documents (${pages} pages) in ${path.relative(process.cwd(), folder)}`);
  console.log(`Next: tar -czf ${name}.tgz -C data/ocr-batch ${name}  and copy it to the GPU (docs/GPU_RUNBOOK.md).`);
}

async function importBatch(): Promise<void> {
  const folder = path.resolve(process.argv[3] ?? "");
  const manifest = (await readFile(path.join(folder, "manifest.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as ManifestRow);
  const report: string[] = [`# PaddleOCR-VL vs Tesseract — ${path.basename(folder)}`, ""];
  let imported = 0;
  for (const row of manifest) {
    const resultFile = path.join(folder, "out", `${row.dir}.txt`);
    const combined = await readFile(resultFile, "utf8").catch(() => null);
    if (!combined) continue;
    const pages = splitPages(combined);
    if (!pages.size) continue;
    const dir = path.join(ROOT, row.dir);
    const metadataPath = path.join(dir, "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, any>;
    const pagesDir = path.join(dir, "ocr-pages");
    const keptDir = path.join(dir, "ocr-pages-tesseract");
    const oldFirst = await readFile(path.join(pagesDir, pageFile(1)), "utf8").catch(() => "");
    if (metadata.ocr?.engine && metadata.ocr.engine !== "paddleocr-vl") {
      await rm(keptDir, { recursive: true, force: true });
      await rename(pagesDir, keptDir).catch(() => null);
      await rename(path.join(dir, "ocr.txt"), path.join(dir, "ocr-tesseract.txt")).catch(() => null);
    }
    await mkdir(pagesDir, { recursive: true });
    for (const [pageNumber, text] of pages) await writeFile(path.join(pagesDir, pageFile(pageNumber)), text + "\n");
    const text = [...pages].map(([pageNumber, pageText]) => `\n\n===== PAGE ${pageNumber} =====\n\n${pageText}\n`).join("");
    await writeFile(path.join(dir, "ocr.txt"), text, "utf8");
    const normalized = normalize(text);
    metadata.ocr = {
      required: true,
      completed: true,
      engine: "paddleocr-vl",
      textBytes: Buffer.byteLength(text, "utf8"),
      textSha256: text.length ? sha256(text) : null,
      normalizedTextSha256: normalized.length ? sha256(normalized) : null,
      pagesProcessed: pages.size,
      ...(metadata.ocr?.engine && metadata.ocr.engine !== "paddleocr-vl" ? { previous: metadata.ocr } : {}),
    };
    await saveDocumentMetadata(metadataPath, metadata as Parameters<typeof saveDocumentMetadata>[1]);
    imported++;
    report.push(`## ${row.sourceId}`, "", "**Tesseract, page 1**", "", "```", oldFirst.slice(0, 600).trim() || "(none)", "```", "", "**PaddleOCR-VL, page 1**", "", "```", (pages.get(1) ?? "").slice(0, 600), "```", "");
  }
  const reportFile = path.join(folder, "compare.md");
  await writeFile(reportFile, report.join("\n"));
  console.log(`${imported} documents updated. Compare: ${path.relative(process.cwd(), reportFile)}. Then run npm run sync:daily.`);
}

/** Put Tesseract's pages back for every document of a batch. */
async function rollback(): Promise<void> {
  const folder = path.resolve(process.argv[3] ?? "");
  const manifest = (await readFile(path.join(folder, "manifest.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as ManifestRow);
  let restored = 0;
  for (const row of manifest) {
    const dir = path.join(ROOT, row.dir);
    const metadataPath = path.join(dir, "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, any>;
    if (metadata.ocr?.engine !== "paddleocr-vl" || !metadata.ocr.previous) continue;
    await rm(path.join(dir, "ocr-pages"), { recursive: true, force: true });
    await rename(path.join(dir, "ocr-pages-tesseract"), path.join(dir, "ocr-pages")).catch(() => null);
    await rename(path.join(dir, "ocr-tesseract.txt"), path.join(dir, "ocr.txt")).catch(() => null);
    metadata.ocr = metadata.ocr.previous;
    await saveDocumentMetadata(metadataPath, metadata as Parameters<typeof saveDocumentMetadata>[1]);
    restored++;
  }
  console.log(`${restored} documents back on Tesseract. Run npm run sync:daily.`);
}

async function main(): Promise<void> {
  const step = process.argv[2];
  if (step === "export") return exportBatch();
  if (step === "import") return importBatch();
  if (step === "rollback") return rollback();
  throw new Error("Usage: ocr-batch.ts export [--limit N] [--name X] [--all] | import <batch folder> | rollback <batch folder>");
}

if (process.argv[1]?.endsWith("ocr-batch.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
