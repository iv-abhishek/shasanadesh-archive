/**
 * Hindi word list for Hinglish typing (ADR-061): npm run translit:lexicon
 *
 * Collects well-formed Devanagari words from text we trust to be spelled
 * correctly — portal subjects (typed by the departments), OCR output (real
 * Unicode), and native PDF text that passes the text-quality check (legacy-font
 * PDFs produce broken words and are skipped) — counts them, and writes
 * apps/web/public/translit/hi-lexicon.json for the browser. Rebuilt by the daily
 * sync; the app works without it (common words + rules).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeTextQuality } from "../src/lib/text-quality.js";

const root = process.cwd();
const documentsRoot = path.join(root, "data/documents");
const outputPath = path.join(root, "apps/web/public/translit/hi-lexicon.json");
const MAX_WORDS = 50_000;

const counts = new Map<string, number>();
const fromSubjects = new Set<string>();

// A Devanagari word that could exist: starts with a letter (not a vowel sign),
// no two vowel signs in a row, no vowel sign after an independent vowel,
// does not end with a virama, 2–25 characters.
const LETTER = "[\\u0904-\\u0939\\u0958-\\u0961\\u0972-\\u097F]";
const SIGN = "[\\u093A-\\u094F\\u0955-\\u0957\\u0962\\u0963]";
const VALID = new RegExp(`^${LETTER}(?:${LETTER}|\\u093C|\\u094D${LETTER}|${SIGN}(?!${SIGN}))*[\\u0901-\\u0903]?$`, "u");

export function isWellFormed(word: string): boolean {
  if (word.length < 2 || word.length > 25) return false;
  if (/[ऄ०-९।॥]/.test(word)) return false; // rare ऄ, digits, danda
  if (/[अ-औ][ा-ौ]/.test(word)) return false; // vowel sign after a vowel letter
  return VALID.test(word);
}

function addText(text: string, weight: number, subject = false) {
  for (const raw of text.normalize("NFC").replace(/[‌‍]/g, "").match(/[ऀ-ॿ]+/g) ?? []) {
    if (!isWellFormed(raw)) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + weight);
    if (subject) fromSubjects.add(raw);
  }
}

async function readIf(file: string): Promise<string> {
  return readFile(file, "utf8").catch(() => "");
}

async function main() {
  let subjects = 0;
  let cleanTexts = 0;
  let skippedTexts = 0;

  const inventory = await readIf(path.join(root, "data/portal-capture/inventory.jsonl"));
  for (const line of inventory.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { subject?: string };
    if (record.subject) {
      addText(record.subject, 3, true);
      subjects++;
    }
  }

  if (existsSync(documentsRoot)) {
    for (const entry of await readdir(documentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(documentsRoot, entry.name);
      const metadata = JSON.parse((await readIf(path.join(dir, "metadata.json"))) || "{}");
      const subject = metadata.portal?.subject ?? metadata.title;
      if (typeof subject === "string") addText(subject, 3, true);

      // OCR output is real Unicode, whatever the PDF's fonts were.
      for (const folder of ["ocr-pages", "ocr-selective"]) {
        for (const name of await readdir(path.join(dir, folder)).catch(() => [] as string[])) {
          if (name.endsWith(".txt")) addText(await readIf(path.join(dir, folder, name)), 1);
        }
      }

      // Native text only when it is not garbled legacy-font output.
      const pages = await readIf(path.join(dir, "pages.jsonl"));
      const nativeTexts = pages
        ? pages.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { textSource: string; text: string })
            .filter((page) => page.textSource === "native").map((page) => page.text)
        : [await readIf(path.join(dir, "text.txt"))];
      for (const text of nativeTexts) {
        if (!text.trim()) continue;
        if (analyzeTextQuality(text).classification === "ok") {
          addText(text, 1);
          cleanTexts++;
        } else {
          skippedTexts++;
        }
      }
    }
  }

  // Page-text words need two sightings; subject words one (they are typed by people).
  const words = [...counts]
    .filter(([word, count]) => count >= 2 || fromSubjects.has(word))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_WORDS);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify({ version: 1, builtAt: new Date().toISOString(), words }) + "\n", "utf8");

  console.log("Hinglish typing lexicon");
  console.log("=======================");
  console.log(`Subjects read:         ${subjects} (+ archived orders)`);
  console.log(`Clean native texts:    ${cleanTexts} (skipped as garbled: ${skippedTexts})`);
  console.log(`Distinct words kept:   ${words.length}`);
  console.log(`Most frequent:         ${words.slice(0, 12).map(([word]) => word).join(" ")}`);
  console.log(`Output:                ${path.relative(root, outputPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
