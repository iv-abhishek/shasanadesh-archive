/**
 * Display helpers shared by chat source cards and the Search page.
 *
 * Source IDs carry their collection: Shasanadesh IDs look like "61#37#5#2023",
 * other collections use a slug prefix ("doe-gfr-…", "upgov-go-…"). Keep this
 * list in step with src/sources/registry.ts.
 */

import { formatDayKey } from "./app-time";

const COLLECTION_LABELS: Array<{ prefix: string; label: string }> = [
  { prefix: "core-rules-", label: "Core rules" },
  { prefix: "up-fhb-", label: "UP Financial Handbook" },
  { prefix: "doe-gfr-", label: "Dept. of Expenditure, GoI" },
  { prefix: "upgov-", label: "Raj Bhavan UP" },
  { prefix: "invest-up-", label: "Invest UP" },
  { prefix: "uppolice-", label: "UP Police" },
  { prefix: "msme-", label: "Ministry of MSME" },
  { prefix: "submitted-", label: "Submitted link" },
  { prefix: "web-", label: "Official website (live search)" },
  { prefix: "crawl-", label: "Department website" },
];

/** Archives the Search page can filter by (documents.provider values). */
export const SOURCE_COLLECTIONS: Array<{ provider: string; label: string }> = [
  { provider: "shasanadesh-up", label: "Shasanadesh" },
  { provider: "core-rules", label: "Core rules" },
  { provider: "up-fhb", label: "UP Financial Handbook" },
  { provider: "upgov", label: "Raj Bhavan UP" },
  { provider: "invest-up", label: "Invest UP" },
  { provider: "uppolice", label: "UP Police" },
  { provider: "gov-cms-msme", label: "Ministry of MSME" },
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
 * (zero-width joiners used as spaces, "ऄ" in place of "अ", words starting with a
 * vowel sign after dropped conjuncts). Mirrors the signals
 * in src/lib/text-quality.ts; used only to warn the reader.
 */
export function looksGarbled(text: string): boolean {
  const devanagari = (text.match(/[ऀ-ॿ]/g) ?? []).length;
  if (devanagari < 40) return false;
  const joiners = (text.match(/[‌‍]/g) ?? []).length;
  const rareLetters = (text.match(/ऄ/g) ?? []).length;
  const words = text.replace(/[\u200c\u200d]/g, "").match(/[\u0900-\u0963\u0966-\u097F]+/g) ?? [];
  const leadingMarks = words.filter((word) => /^[\u0900-\u0903\u093A-\u094F]/.test(word)).length;
  return (
    (joiners >= 5 && joiners / devanagari > 0.02) ||
    rareLetters >= 2 ||
    (leadingMarks >= 3 && leadingMarks / Math.max(1, words.length) >= 0.02)
  );
}

/** Official Shasanadesh viewer link for an order ID ("seq#dept#section#year"), else null. */
export function officialShasanadeshUrl(sourceId: string): string | null {
  if (!/^\d+#\d+#\d+#\d+$/.test(sourceId)) return null;
  // The ID is ASCII (digits and #), so btoa is safe in the browser and in Node.
  return `https://shasanadesh.up.gov.in/GO/ViewGOPDF_list_user.aspx?id1=${encodeURIComponent(btoa(sourceId))}`;
}

export type LaterChangeKind = "supersedes" | "amends" | "cancels" | "corrects";

export interface LaterChange {
  kind: LaterChangeKind;
  bySourceId: string;
  byGoNumber: string | null;
  byGoDate: string | null;
}

const LATER_CHANGE_WORDS: Record<LaterChangeKind, { en: string; hi: string }> = {
  cancels: { en: "Cancelled by", hi: "निरस्त —" },
  supersedes: { en: "Superseded by", hi: "अतिक्रमित —" },
  amends: { en: "Amended by", hi: "संशोधित —" },
  corrects: { en: "Corrected by", hi: "शुद्धि-पत्र —" },
};

/** "Amended by GO 9/2026/… dated 01/07/2026" (or the Hindi form) for a source card. */
export function describeLaterChange(change: LaterChange, language: "hi" | "en"): string {
  const date = formatGoDate(change.byGoDate);
  const order = change.byGoNumber
    ? language === "hi" ? `शासनादेश संख्या ${change.byGoNumber}` : `GO ${change.byGoNumber}`
    : language === "hi" ? "बाद का शासनादेश" : "a later order";
  const dated = date ? (language === "hi" ? `, दिनांक ${date}` : ` dated ${date}`) : "";
  return `${LATER_CHANGE_WORDS[change.kind][language]} ${order}${dated}`;
}

/** Keep only well-formed later-change entries from a stream or saved message. */
export function readLaterChanges(value: unknown): LaterChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = item as Record<string, unknown>;
    if (!raw || typeof raw.bySourceId !== "string" || typeof raw.kind !== "string" || !Object.hasOwn(LATER_CHANGE_WORDS, raw.kind)) return [];
    return [{
      kind: raw.kind as LaterChangeKind,
      bySourceId: raw.bySourceId,
      byGoNumber: typeof raw.byGoNumber === "string" ? raw.byGoNumber : null,
      byGoDate: typeof raw.byGoDate === "string" ? raw.byGoDate : null,
    }];
  });
}

/** A rulebook rule changed by a GO (ADR-094), as shown on either side's source card. */
export interface RuleAmendment {
  direction: "amended_by" | "amends";
  rule: string;
  goNumber: string;
  goDate: string | null;
  goSourceId: string | null;
}

export function readRuleAmendments(value: unknown): RuleAmendment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = item as Record<string, unknown>;
    if (!raw || (raw.direction !== "amended_by" && raw.direction !== "amends") || typeof raw.rule !== "string" || typeof raw.goNumber !== "string") return [];
    return [{
      direction: raw.direction,
      rule: raw.rule,
      goNumber: raw.goNumber,
      goDate: typeof raw.goDate === "string" ? raw.goDate : null,
      goSourceId: typeof raw.goSourceId === "string" ? raw.goSourceId : null,
    }];
  });
}

/** "Amended by GO … dated …" on the rule's card; "Amends: <rule>" on the GO's card. */
export function describeRuleAmendment(note: RuleAmendment, language: "hi" | "en"): string {
  if (note.direction === "amends") return language === "hi" ? `संशोधन करता है: ${note.rule}` : `Amends: ${note.rule}`;
  const date = formatGoDate(note.goDate);
  const dated = date ? (language === "hi" ? `, दिनांक ${date}` : ` dated ${date}`) : "";
  const missing = note.goSourceId ? "" : language === "hi" ? " (संग्रह में उपलब्ध नहीं)" : " (not in the archive)";
  return language === "hi"
    ? `संशोधित — शासनादेश संख्या ${note.goNumber}${dated}${missing}`
    : `Amended by GO ${note.goNumber}${dated}${missing}`;
}
