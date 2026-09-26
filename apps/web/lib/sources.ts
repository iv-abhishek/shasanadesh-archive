/**
 * Display helpers shared by chat source cards and the Search page.
 *
 * Source IDs carry their collection: Shasanadesh IDs look like "61#37#5#2023",
 * other collections use a slug prefix ("doe-gfr-…", "upgov-go-…"). Keep this
 * list in step with src/sources/registry.ts.
 */

import { formatDayKey } from "./app-time";

const COLLECTION_LABELS: Array<{ prefix: string; label: string }> = [
  { prefix: "doe-gfr-", label: "Dept. of Expenditure, GoI" },
  { prefix: "upgov-", label: "Raj Bhavan UP" },
  { prefix: "invest-up-", label: "Invest UP" },
  { prefix: "uppolice-", label: "UP Police" },
  { prefix: "submitted-", label: "Submitted link" },
];

/** Archives the Search page can filter by (documents.provider values). */
export const SOURCE_COLLECTIONS: Array<{ provider: string; label: string }> = [
  { provider: "shasanadesh-up", label: "Shasanadesh" },
  { provider: "upgov", label: "Raj Bhavan UP" },
  { provider: "invest-up", label: "Invest UP" },
  { provider: "uppolice", label: "UP Police" },
  { provider: "doe-gfr", label: "Dept. of Expenditure, GoI" },
  { provider: "submitted", label: "Submitted links" },
];

/** Which archive a document came from, for a short label under its title. */
export function sourceCollectionLabel(sourceId: string): string {
  return COLLECTION_LABELS.find(({ prefix }) => sourceId.startsWith(prefix))?.label ?? "Shasanadesh";
}

/** "2023-09-15" → "15 Sept 2023"; anything else is returned unchanged. */
export function formatGoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDayKey(value, true) : value;
}

/**
 * True when a page's text layer looks like a broken legacy-font export
 * (zero-width joiners used as spaces, "ऄ" in place of "अ"). Mirrors the signals
 * in src/lib/text-quality.ts; used only to warn the reader.
 */
export function looksGarbled(text: string): boolean {
  const devanagari = (text.match(/[ऀ-ॿ]/g) ?? []).length;
  if (devanagari < 40) return false;
  const joiners = (text.match(/[‌‍]/g) ?? []).length;
  const rareLetters = (text.match(/ऄ/g) ?? []).length;
  return (joiners >= 5 && joiners / devanagari > 0.02) || rareLetters >= 2;
}
