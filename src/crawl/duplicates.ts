/**
 * Pipeline stage: crawl — the same order already in the archive (ADR-103)
 *
 * Purpose:
 *   Many department sites post the GOs that Shasanadesh already holds. A crawled
 *   document that is the same file, the same text, or the same order (same
 *   number and date, and its text agrees) is marked duplicateOf the archived
 *   copy: it keeps its metadata (the department's own link), but it is not split
 *   into pages or uploaded, so answers cite one copy — the archived one, which
 *   carries the portal's department, category and subject.
 *
 * Invariants:
 *   - only crawled documents (crawl-*) are ever marked; archived ones are untouched
 *   - same number and date without comparable text (a scan) is only flagged
 *     possibleDuplicateOf; the document stays searchable
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface DuplicateVerdict {
  kind: "exact" | "same-order" | "possible";
  of: string;
  reason: string;
}

interface Known {
  sourceId: string;
  dir: string;
}

interface KnownIndex {
  bySha: Map<string, string>;
  byText: Map<string, string>;
  byOrder: Map<string, Known[]>;
}

const DEVANAGARI_DIGITS = "०१२३४५६७८९";
let indexPromise: Promise<KnownIndex> | null = null;

function asciiDigits(value: string): string {
  return value.replace(/[०-९]/g, (digit) => String(DEVANAGARI_DIGITS.indexOf(digit)));
}

/** "31/08/2021" or "2021-08-31" → "2021-08-31". */
export function isoDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = asciiDigits(value.trim());
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dayFirst = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  return dayFirst ? `${dayFirst[3]}-${dayFirst[2].padStart(2, "0")}-${dayFirst[1].padStart(2, "0")}` : null;
}

/** The order's own serial: the first number in its GO number ("1342/नौ-4-2020…" → "1342"). */
export function orderKey(goNumber: unknown, goDate: unknown): string | null {
  if (typeof goNumber !== "string") return null;
  const lead = asciiDigits(goNumber).match(/\d+/)?.[0]?.replace(/^0+/, "");
  const day = isoDay(goDate);
  return lead && day ? `${lead}|${day}` : null;
}

function words(text: string): Set<string> {
  return new Set(
    text
      .slice(0, 4000)
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3),
  );
}

export function overlap(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size < 15 || right.size < 15) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.min(left.size, right.size);
}

async function buildIndex(root: string): Promise<KnownIndex> {
  const index: KnownIndex = { bySha: new Map(), byText: new Map(), byOrder: new Map() };
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("crawl-")) continue;
    const dir = path.join(root, entry.name);
    let metadata: Record<string, any>;
    try {
      metadata = JSON.parse(await readFile(path.join(dir, "metadata.json"), "utf8"));
    } catch {
      continue;
    }
    const sourceId = String(metadata.sourceId ?? entry.name);
    const sha = metadata.capture?.rawSha256;
    const textSha = metadata.text?.normalizedTextSha256;
    if (typeof sha === "string") index.bySha.set(sha, sourceId);
    if (typeof textSha === "string") index.byText.set(textSha, sourceId);
    const key = orderKey(metadata.goNumber, metadata.goDate);
    if (key) {
      const list = index.byOrder.get(key) ?? [];
      list.push({ sourceId, dir });
      index.byOrder.set(key, list);
    }
  }
  return index;
}

/** Read the archive once per run (about a minute for 140k documents). */
function knownIndex(root: string): Promise<KnownIndex> {
  if (!indexPromise) {
    console.log("Reading the archive once to recognise orders it already holds …");
    indexPromise = buildIndex(root);
  }
  return indexPromise;
}

export async function findDuplicate(
  metadata: Record<string, any>,
  text: string,
  root = path.resolve("data/documents"),
): Promise<DuplicateVerdict | null> {
  const index = await knownIndex(root);
  const sha = metadata.capture?.rawSha256;
  if (typeof sha === "string" && index.bySha.has(sha)) return { kind: "exact", of: index.bySha.get(sha)!, reason: "same file" };
  const textSha = metadata.text?.normalizedTextSha256;
  if (typeof textSha === "string" && index.byText.has(textSha)) return { kind: "exact", of: index.byText.get(textSha)!, reason: "same text" };
  const key = orderKey(metadata.goNumber, metadata.goDate);
  const candidates = key ? (index.byOrder.get(key) ?? []) : [];
  if (!candidates.length) return null;
  let best: { known: Known; score: number } | null = null;
  let compared = false;
  for (const known of candidates) {
    const other = await readFile(path.join(known.dir, "text.txt"), "utf8").catch(() => "");
    const score = overlap(text, other);
    if (words(text).size >= 15 && words(other).size >= 15) compared = true;
    if (!best || score > best.score) best = { known, score };
  }
  if (best && best.score >= 0.5) {
    return { kind: "same-order", of: best.known.sourceId, reason: `same number and date; ${Math.round(best.score * 100)}% of words shared` };
  }
  // Both texts readable and different: another order that shares a number and date.
  if (compared) return null;
  return { kind: "possible", of: candidates[0].sourceId, reason: "same number and date; text not comparable (scan)" };
}
