/**
 * Pipeline stage: source discovery (UP Financial Handbook, HTML volumes)
 *
 * Purpose:
 *   The Uttar Pradesh Financial Handbook (वित्तीय हस्तपुस्तिका) is published by
 *   the Finance Department on budget.up.nic.in as plain HTML: one index page per
 *   volume linking one page per chapter (or group of paragraphs). There is no
 *   PDF of these volumes. This module knows the volumes, reads an index into an
 *   ordered list of chapter pages, turns a chapter page into text, and splits
 *   long chapters into page-sized parts. src/ingest-handbook.ts does the
 *   fetching and writes the documents.
 *
 * Invariants:
 *   - every part keeps the official URL of the chapter page it came from, so a
 *     citation opens the exact government page (docs/RULES.md §1)
 *   - links that leave the volume's folder (navigation back to the budget
 *     site) and non-HTML links (one Vol. II chapter is a .doc) are not pages;
 *     they are reported, never fetched as text
 *   - the pages are windows-1252 (FrontPage era); decoding follows the page's
 *     declared charset and falls back to windows-1252
 *
 * Vol. VI is published as chapter PDFs and goes through the core-rules
 * catalogue (datasets/core-rules/incoming), not this reader.
 */

import { decodeEntities } from "./html.js";

export const FHB_HOST = "budget.up.nic.in";
export const FHB_COLLECTION = "up-fhb";
export const FHB_INDEX_PAGE = "https://budget.up.nic.in/finhando.htm";

export interface HandbookVolume {
  /** Short id used on the command line (--volume vol5-part1). */
  id: string;
  sourceId: string;
  title: string;
  titleHi: string;
  /** The volume's own index page on budget.up.nic.in. */
  indexUrl: string;
  topics: string[];
  /** One line on what the volume contains, kept in metadata for people. */
  scope: string;
}

const BASE = "https://budget.up.nic.in/Fin_H_Book/";

export const HANDBOOK_VOLUMES: readonly HandbookVolume[] = [
  {
    id: "vol2",
    sourceId: "up-fhb-vol2",
    title: "Financial Handbook, Volume II, Parts II–IV (Fundamental Rules and Subsidiary Rules), Uttar Pradesh",
    titleHi: "वित्तीय हस्तपुस्तिका खण्ड-2, भाग 2 से 4 (मूल नियम एवं सहायक नियम), उत्तर प्रदेश",
    indexUrl: BASE + "volume2/financial%20handbook%20ii.html",
    topics: ["service", "pay-allowances", "financial-rules"],
    scope: "UP Fundamental Rules and Subsidiary Rules: pay, allowances, leave, joining time, foreign service, deputation.",
  },
  {
    id: "vol3",
    sourceId: "up-fhb-vol3",
    title: "Financial Handbook, Volume III (Travelling Allowance Rules), Uttar Pradesh",
    titleHi: "वित्तीय हस्तपुस्तिका खण्ड-3 (यात्रा भत्ता नियम), उत्तर प्रदेश",
    indexUrl: BASE + "volume3/financial%20handbook1.html",
    topics: ["pay-allowances", "financial-rules"],
    scope: "Travelling allowance rules for UP government servants, with the government orders printed in the volume.",
  },
  {
    id: "vol5-part1",
    sourceId: "up-fhb-vol5-part1",
    title: "Financial Handbook, Volume V, Part I (Account Rules), Uttar Pradesh",
    titleHi: "वित्तीय हस्तपुस्तिका खण्ड-5, भाग-1 (लेखा नियम), उत्तर प्रदेश",
    indexUrl: BASE + "volume5/part1/index.html",
    topics: ["financial-rules", "budget-accounts", "audit"],
    scope: "General account rules for departmental officers: drawing and disbursing, bills, cash, stores, losses, audit.",
  },
  {
    id: "vol5-part2",
    sourceId: "up-fhb-vol5-part2",
    title: "Financial Handbook, Volume V, Part II (Treasury Rules), Uttar Pradesh",
    titleHi: "वित्तीय हस्तपुस्तिका खण्ड-5, भाग-2 (कोषागार नियम), उत्तर प्रदेश",
    indexUrl: BASE + "volume5/part2/PREFACE.htm",
    topics: ["budget-accounts", "financial-rules", "pension"],
    scope: "Procedure of treasuries: receipts, payments, pension payments, deposits, treasury forms.",
  },
  {
    id: "vol7",
    sourceId: "up-fhb-vol7",
    title: "Financial Handbook, Volume VII (Forest Department Accounts), Uttar Pradesh",
    titleHi: "वित्तीय हस्तपुस्तिका खण्ड-7 (वन विभाग लेखा), उत्तर प्रदेश",
    indexUrl: BASE + "volume7/index.html",
    topics: ["budget-accounts", "financial-rules"],
    scope: "Financial transactions and initial accounts of the Forest Department (divisional forest officers).",
  },
  {
    id: "csr",
    sourceId: "up-fhb-csr",
    title: "Civil Service Regulations (as applicable in Uttar Pradesh)",
    titleHi: "सिविल सर्विस रेगुलेशन्स (उत्तर प्रदेश में यथा लागू)",
    indexUrl: BASE + "CSR/index.html",
    topics: ["pension", "service"],
    scope: "Conditions under which pension is earned: qualifying service, kinds of pension, payment of pensions.",
  },
];

export function handbookVolume(id: string): HandbookVolume {
  const volume = HANDBOOK_VOLUMES.find((item) => item.id === id || item.sourceId === id);
  if (!volume) {
    throw new Error(`Unknown handbook volume "${id}". Known: ${HANDBOOK_VOLUMES.map((item) => item.id).join(", ")}`);
  }
  return volume;
}

/** Decode by the page's declared charset; these sites default to windows-1252. */
export function decodeHandbookHtml(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const declared = head.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]?.toLowerCase();
  const charset = declared && /^(utf-?8|windows-125[0-8]|iso-8859-\d+)$/.test(declared) ? declared : "windows-1252";
  return new TextDecoder(charset === "utf8" ? "utf-8" : charset).decode(bytes);
}

export interface IndexEntry {
  /** Absolute official URL of the chapter page, without a fragment. */
  url: string;
  /** Index labels for this page joined: "CHAPTER II—DEFINITIONS (4—18)". */
  label: string;
}

export interface IndexReading {
  entries: IndexEntry[];
  /** Links that are not chapter pages of this volume (e.g. a .doc chapter). */
  skipped: Array<{ url: string; label: string; reason: string }>;
}

/**
 * FrontPage wrote windows-1252 punctuation as numeric references in the
 * C1 range (&#151; for "—", &#146; for "’"); read them as windows-1252.
 */
function decodeHtmlText(value: string): string {
  const cp1252 = new TextDecoder("windows-1252");
  return decodeEntities(
    value.replace(/&#(1[2-5]\d);/g, (_match, code: string) => cp1252.decode(Uint8Array.of(Number(code)))),
  );
}

function cleanLabel(value: string): string {
  return decodeHtmlText(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Paragraph ranges like "1—4–A", "348–A—357–C", "401-469A": shown after the title. */
const PARA_RANGE = /^\d[\d\s.,–—-]*[A-Z]?(?:\s*[–—-]\s*\d+[\s–—-]*[A-Z]?)*$/;
/** Vol. II's index labels are only its file numbers ("001"); they say nothing. */
const FILE_NUMBER = /^\d{3}$/;

/**
 * Read a volume index into its chapter pages, in index order. Each page is
 * usually linked twice (title, then paragraph range); the labels are merged.
 */
export function parseHandbookIndex(html: string, indexUrl: string): IndexReading {
  const folder = new URL(".", indexUrl).href;
  const order: string[] = [];
  const labels = new Map<string, string[]>();
  const skipped: IndexReading["skipped"] = [];
  const seenSkipped = new Set<string>();

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = match[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const raw = href?.[1] ?? href?.[2] ?? href?.[3];
    if (!raw || /^(javascript:|mailto:|#)/i.test(raw)) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(raw.trim()), indexUrl);
    } catch {
      continue;
    }
    url.hash = "";
    const label = cleanLabel(match[2]);
    const key = url.href;
    if (url.hostname !== FHB_HOST || !key.startsWith(folder)) continue; // navigation out of the volume
    // One Vol. V Part II link is misspelt "030.HMT"; it is still a page.
    if (!/\.(html?|hmt)$/i.test(url.pathname)) {
      if (!seenSkipped.has(key)) {
        seenSkipped.add(key);
        skipped.push({ url: key, label, reason: "not an HTML page" });
      }
      continue;
    }
    if (key === new URL(indexUrl).href) continue;
    if (!labels.has(key)) {
      labels.set(key, []);
      order.push(key);
    }
    if (label && !labels.get(key)!.includes(label)) labels.get(key)!.push(label);
  }

  const entries = order.map((url) => {
    const parts = labels.get(url)!.filter((part) => !FILE_NUMBER.test(part));
    const ranges = parts.filter((part) => PARA_RANGE.test(part));
    const titles = parts.filter((part) => !ranges.includes(part));
    const title = titles.join(" — ");
    const range = ranges.join(", ");
    const label = title && range ? `${title} (paras ${range})` : title || (range ? `Paras ${range}` : "");
    return { url, label };
  });
  return { entries, skipped };
}

const BLOCK = /<\/?(p|br|div|tr|table|h[1-6]|li|ul|ol|blockquote|pre|center|hr)\b[^>]*>/gi;

/**
 * A chapter page as text: one line per paragraph or table row, cells joined
 * with " | ", and the first short line as the heading for the citation label.
 */
export function handbookPageText(html: string): { heading: string | null; text: string } {
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  // Source newlines are only line wraps inside a paragraph; paragraphs come
  // from the block tags.
  const cleaned = body
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, " | ")
    .replace(BLOCK, "\n")
    .replace(/<[^>]+>/g, " ");
  const lines = decodeHtmlText(cleaned)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").replace(/^\s*\|\s*|\s*\|\s*$/g, "").trim())
    .filter((line) => line && !/^\|?$/.test(line));
  // The page's first short line is its heading ("CHAPTER I—EXTENT OF APPLICATION").
  const heading = lines.find((line) => line.length <= 120 && /[A-Za-z]{3,}/.test(line)) ?? null;
  return { heading, text: lines.join("\n") };
}

/**
 * Split a chapter into parts of at most maxChars, at line (paragraph)
 * boundaries; a single paragraph longer than that is split at sentence ends.
 * Retrieval and answer evidence work page by page, so a 60,000-character
 * chapter must not become one "page".
 */
export function splitHandbookText(text: string, maxChars = 3500): string[] {
  const pieces: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= maxChars) {
      pieces.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > maxChars) {
      const window = rest.slice(0, maxChars);
      const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "), window.lastIndexOf("। "));
      const at = cut > maxChars * 0.5 ? cut + 1 : window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : maxChars;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }

  const parts: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + 1 + piece.length > maxChars) {
      parts.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export interface ChapterRead {
  url: string;
  label: string;
  heading: string | null;
  text: string;
  rawSha256: string;
  html: string;
}

export interface PagePart {
  url: string;
  chapter: string;
  text: string;
}

/** Page parts of a volume, each headed with the volume and chapter it belongs to. */
export function volumeParts(volume: HandbookVolume, chapters: ChapterRead[], partChars = 3500): { parts: PagePart[]; entries: Array<{ url: string; label: string; firstPage: number; lastPage: number }> } {
  const parts: PagePart[] = [];
  const entries: Array<{ url: string; label: string; firstPage: number; lastPage: number }> = [];
  for (const chapter of chapters) {
    const chapterLabel = chapter.label || chapter.heading || chapter.url.split("/").pop() || "";
    const pieces = splitHandbookText(chapter.text, partChars);
    if (!pieces.length) continue;
    const firstPage = parts.length + 1;
    pieces.forEach((piece, index) => {
      const partNote = pieces.length > 1 ? ` (part ${index + 1} of ${pieces.length})` : "";
      // The context line helps retrieval and tells the reader where the text sits.
      const header = `[${volume.title} — ${chapterLabel}${partNote}]`;
      parts.push({ url: chapter.url, chapter: chapterLabel, text: `${header}\n${piece}` });
    });
    entries.push({ url: chapter.url, label: chapterLabel, firstPage, lastPage: parts.length });
  }
  return { parts, entries };
}
