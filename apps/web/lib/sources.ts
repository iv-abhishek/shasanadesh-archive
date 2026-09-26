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

/**
 * Grouping key for a department name. Portal names carry zero-width joiners
 * and varying spaces ("चिकित्‍सा शिक्षा"), so the same department must not split
 * into two groups because of invisible characters or letter case.
 */
export function departmentKey(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

/**
 * Shasanadesh IDs are "sequence#departmentId#sectionId#year". The department
 * ID is the same whether the listing named the department in English
 * ("Agriculture") or Hindi ("कृषि विभाग"), so it is the reliable grouping key.
 */
export function shasanadeshDepartmentId(sourceId: string): number | null {
  const match = /^\d+#(\d+)#\d+#\d{4}$/.exec(sourceId);
  return match ? Number(match[1]) : null;
}

/** "2023-09-15" or "15/09/2023" → "15 Sept 2023"; anything else is returned unchanged. */
export function formatGoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDayKey(value, true);
  // Portal listing dates are day-first: "26/09/2026".
  const dayFirst = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (dayFirst) {
    const [, day, month, year] = dayFirst;
    return formatDayKey(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`, true);
  }
  return value;
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
