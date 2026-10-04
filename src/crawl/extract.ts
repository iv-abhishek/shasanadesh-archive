/**
 * Pipeline stage: crawl — reading a listing page (ADR-103)
 *
 * Purpose:
 *   Turn one official listing page into document entries without a per-site
 *   parser. Government listing pages are nearly always a table with one row per
 *   order (serial, GO number, date, subject, "View/Download"), or a list of
 *   links. For each document link we read its row: the subject is the longest
 *   meaningful cell, the date the first day-first date, the GO number the cell
 *   that looks like one.
 *
 * Invariants:
 *   - pure functions over HTML text; fetching lives in crawl-sites.ts
 *   - only links that are documents (.pdf, or the site's docLinkPattern)
 *   - nothing is guessed that the page does not say; missing fields stay null
 */

import { decodeEntities, guessLanguage, parseDayFirstDate, parseEnglishLongDate, textContent } from "../sources/html.js";

export interface ListingItem {
  url: string;
  title: string;
  linkLabel: string;
  date: string | null;
  goNumber: string | null;
  language: "hi" | "en" | "mixed" | "unknown";
  /** The row's cells (or the list item's text), verbatim. */
  cells: string[];
}

export interface PostBack {
  target: string;
  argument: string;
}

export interface PagerInfo {
  links: string[];
  postBacks: PostBack[];
  /** "Displaying 1 - 10 of 63" → 63. */
  totalItems: number | null;
  pageSize: number | null;
}

const GENERIC_LABEL = /^(view|download|view\s*\/\s*download|click here|here|pdf|open|read more|details?|देखें|डाउनलोड|यहाँ क्लिक करें|क्लिक करें|विवरण|डाउनलोड करें|\[?\s*\d+(\.\d+)?\s*(kb|mb)\s*\]?)$/i;
const SIZE_OR_LANGUAGE = /\[\s*\d+(\.\d+)?\s*(kb|mb|bytes)\s*\]|\(\s*\d+(\.\d+)?\s*(kb|mb)\s*\)|language\s*:\s*(hindi|english|both|hindi\s*&\s*english)|भाषा\s*:\s*\S+|\bpdf\b\s*\d*\s*(kb|mb)?|\s\d+(\.\d+)?\s*(kb|mb)\s*$/gi;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "12 Jun 2024", "09th June, 2020", "4 March 2021" → ISO date. */
export function parseDayMonthYear(value: string): string | null {
  const match = value.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (!match) return null;
  const month = MONTHS.indexOf(match[2].slice(0, 3).toLowerCase());
  const day = Number(match[1]);
  if (month < 0 || day < 1 || day > 31 || Number(match[3]) < 1900) return null;
  return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function anyDate(text: string): string | null {
  return parseDayFirstDate(text) ?? parseEnglishLongDate(text) ?? parseDayMonthYear(text);
}

/** Attribute value, quoted or not (some NIC pages write href=book/Chapter-1.pdf). */
export function looseAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

export function isDocumentLink(url: string, docLinkPattern?: RegExp): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (/\.pdf$/i.test(decodeURIComponent(parsed.pathname).trim())) return true;
  } catch {
    return false;
  }
  return Boolean(docLinkPattern?.test(url));
}

function resolve(href: string, baseUrl: string): string | null {
  // Spaces and backslashes appear in hand-written NIC pages.
  const cleaned = href.trim().replace(/\\/g, "/").replace(/ /g, "%20");
  if (!cleaned || /^(javascript:|mailto:|tel:|#)/i.test(cleaned)) return null;
  try {
    const url = new URL(cleaned, baseUrl);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

interface Anchor {
  url: string;
  label: string;
  start: number;
}

function anchorsIn(html: string, baseUrl: string): Anchor[] {
  const found: Anchor[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = looseAttribute(match[1], "href");
    const url = href ? resolve(href, baseUrl) : null;
    if (!url) continue;
    const title = looseAttribute(match[1], "title");
    const label = (textContent(match[2]) || title || "").replace(/[\u200b-\u200d\ufeff]/g, "");
    found.push({ url, label: label.trim(), start: match.index ?? 0 });
  }
  return found;
}

function cleanCell(text: string): string {
  return text.replace(SIZE_OR_LANGUAGE, " ").replace(/\s+/g, " ").trim();
}

function isDateOnly(text: string): boolean {
  return (
    /^\s*\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\s*$/.test(text) ||
    /^\s*[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}\s*$/.test(text) ||
    /^\s*\d{1,2}(st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}\s*$/.test(text)
  );
}

function isSerial(text: string): boolean {
  return /^\s*\d{1,5}\s*\.?\s*$/.test(text);
}

/** "1728/नौ-9-2020-161ज/2012", "G-4-484/X-90-216-79", "संख्या-1889/33-3-20", "823/78-2-2021-254 L.C/2019TC". */
export function looksLikeGoNumber(text: string): boolean {
  const value = text.replace(/^(संख्या|सं0|सं\.|no\.?|number|शासनादेश\s*संख्या)\s*[:\-–]?\s*/i, "").trim();
  if (value.length < 4 || value.length > 70 || isDateOnly(value)) return false;
  if (!/\d/.test(value) || !/[/\-]/.test(value)) return false;
  const words = value.replace(/\s*([/\-–])\s*/g, "$1").split(/\s+/).length;
  return words <= 6 && /\d+\s*\/\s*\S+|[A-Za-zऀ-ॿ]+[-–]\d+[-/]/.test(value);
}

function dateIn(texts: string[]): string | null {
  for (const text of texts) {
    if (isDateOnly(text)) {
      const value = anyDate(text);
      if (value) return value;
    }
  }
  for (const text of texts) {
    const value = anyDate(text);
    if (value) return value;
  }
  return null;
}

// "11/2024/S-3-227/10-19099/4/2024 / 12 Jun 2024": number and date in one cell.
const TRAILING_DATE = /\s+(\/|dated|dt\.?|दिनांक)\s*((?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-]\d{2,4}|\d{1,2}(st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4})\s*$/i;

function goNumberIn(cells: string[], label: string, title: string): string | null {
  const candidates = [label, ...cells].map((cell) => cleanCell(cell).replace(TRAILING_DATE, "").trim());
  const cell = candidates.find((value) => looksLikeGoNumber(value));
  if (cell) return cell.replace(/^(संख्या|सं0|no\.?)\s*[:\-–]?\s*/i, "").trim();
  const inTitle = title.match(/(?:संख्या|सं0|No\.)\s*[:\-–]?\s*([\dA-Za-zऀ-ॿ.]+(?:\s*[/\-–]\s*[\dA-Za-zऀ-ॿ.()]+){2,})/);
  return inTitle ? inTitle[1].trim() : null;
}

function languageOf(rowText: string, title: string, siteLanguage: string): ListingItem["language"] {
  const stated = rowText.match(/(?:language|भाषा)\s*:\s*(hindi|english|हिंदी|हिन्दी|अंग्रेजी)/i)?.[1]?.toLowerCase();
  if (stated) return /hindi|हिंदी|हिन्दी/.test(stated) ? "hi" : "en";
  if (siteLanguage === "hi" || siteLanguage === "en") {
    const guessed = guessLanguage(title);
    return guessed === "unknown" ? siteLanguage : guessed;
  }
  return guessLanguage(title);
}

function titleFrom(cells: string[], label: string, url: string): string {
  const meaningful = (text: string) =>
    text.length >= 6 && !GENERIC_LABEL.test(text) && !isDateOnly(text) && !isSerial(text) && !looksLikeGoNumber(text);
  const options = [...cells, label].map(cleanCell).filter(meaningful);
  // The subject, not a paragraph-long description beside it.
  const short = options.filter((text) => text.length <= 250);
  const pool = short.some((text) => text.length >= 20) ? short : options;
  if (pool.length) {
    const best = pool.reduce((longest, text) => (text.length > longest.length ? text : longest));
    return best.length > 300 ? best.slice(0, 297).trimEnd() + "…" : best;
  }
  const cleanedLabel = cleanCell(label);
  if (cleanedLabel && !GENERIC_LABEL.test(cleanedLabel)) return cleanedLabel;
  const file = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "document");
  return file.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim() || "Document";
}

/** Row segments: [start, end, html] for every <tr>…</tr> (innermost rows win). */
function rows(html: string): Array<{ start: number; end: number; html: string }> {
  const found: Array<{ start: number; end: number; html: string }> = [];
  for (const match of html.matchAll(/<tr\b[^>]*>((?:(?!<tr\b)[\s\S])*?)<\/tr>/gi)) {
    const start = match.index ?? 0;
    found.push({ start, end: start + match[0].length, html: match[1] });
  }
  return found;
}

function cellsOf(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)(?=<t[dh]\b|$)/gi)]
    .map((match) => textContent(match[1].replace(/<\/t[dh]>/gi, " ")).replace(/[\u200b-\u200d\ufeff]/g, ""))
    .filter((text) => text.length > 0);
}

/** Text of the list item or paragraph around a link (for link lists outside tables). */
function blockAround(html: string, position: number): string {
  const openers = ["<li", "<p", "<div"];
  let start = -1;
  for (const tag of openers) start = Math.max(start, html.lastIndexOf(tag, position));
  if (start < 0 || position - start > 3000) return "";
  const closeTag = html.slice(start + 1, start + 4).replace(/[^a-z]/gi, "").toLowerCase();
  const end = html.indexOf(`</${closeTag}`, position);
  if (end < 0 || end - position > 3000) return "";
  const block = html.slice(start, end);
  // A menu or a list of several links does not describe this one link.
  if ((block.match(/<a\b/gi) ?? []).length > 2) return "";
  const text = textContent(block).replace(/[\u200b-\u200d\ufeff]/g, "");
  // A whole menu or page section is not this link's description.
  return text.length > 400 ? "" : text;
}

export function extractItems(
  html: string,
  pageUrl: string,
  options: { docLinkPattern?: RegExp; siteLanguage?: string } = {},
): ListingItem[] {
  const body = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (match) => " ".repeat(match.length));
  const tableRows = rows(body);
  const items = new Map<string, ListingItem>();

  for (const anchor of anchorsIn(body, pageUrl)) {
    if (!isDocumentLink(anchor.url, options.docLinkPattern)) continue;
    const row = tableRows.find((candidate) => anchor.start >= candidate.start && anchor.start < candidate.end);
    const cells = row ? cellsOf(row.html) : [blockAround(body, anchor.start)].filter(Boolean);
    // A row holding many documents (a whole table squeezed into one <tr>) says nothing about each one.
    const rowLinks = row ? (row.html.match(/<a\b/gi) ?? []).length : 1;
    const usable = rowLinks > 4 ? [] : cells;
    const title = titleFrom(usable.length ? usable : [anchor.label], anchor.label, anchor.url);
    const rowText = usable.join(" | ");
    const item: ListingItem = {
      url: anchor.url,
      title,
      linkLabel: anchor.label,
      date: dateIn(usable.length ? usable : [anchor.label]),
      goNumber: goNumberIn(usable, anchor.label, title),
      language: languageOf(rowText, title, options.siteLanguage ?? "both"),
      cells: usable,
    };
    const existing = items.get(anchor.url);
    // The same file linked twice (menu and table): keep the richer entry.
    if (!existing || item.cells.length > existing.cells.length) items.set(anchor.url, item);
  }
  return [...items.values()];
}

/** Pagination on the page: plain page links and ASP.NET GridView postbacks. */
export function pagerOf(html: string, pageUrl: string): PagerInfo {
  const current = new URL(pageUrl);
  const links = new Set<string>();
  for (const anchor of anchorsIn(html, pageUrl)) {
    let url: URL;
    try {
      url = new URL(anchor.url);
    } catch {
      continue;
    }
    if (url.hostname !== current.hostname) continue;
    const pageParam = [...url.searchParams.keys()].find((key) => /^(page|pg|p|pageno|page_no|start)$/i.test(key));
    const pathPage = /\/page\/\d+\/?$/.test(url.pathname);
    const samePath = url.pathname.replace(/\/page\/\d+\/?$/, "/") === current.pathname.replace(/\/page\/\d+\/?$/, "/");
    if (samePath && (pageParam || pathPage) && url.href !== current.href) links.add(url.href);
  }
  const postBacks: PostBack[] = [];
  const decoded = decodeEntities(html);
  for (const match of decoded.matchAll(/__doPostBack\('([^']+)','(Page\$(?:\d+|Next|Last|First|Prev))'\)/g)) {
    if (!postBacks.some((known) => known.target === match[1] && known.argument === match[2])) {
      postBacks.push({ target: match[1], argument: match[2] });
    }
  }
  const displaying = decoded.match(/Displaying\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i);
  const totalItems = displaying ? Number(displaying[3]) : null;
  const pageSize = displaying ? Number(displaying[2]) - Number(displaying[1]) + 1 : null;
  return { links: [...links], postBacks, totalItems, pageSize };
}

/** The form fields an ASP.NET page posts back (hidden inputs, text inputs, selected options). */
export function formFields(html: string): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  const form = html.match(/<form\b[^>]*>([\s\S]*?)<\/form>/i)?.[1] ?? html;
  for (const match of form.matchAll(/<input\b([^>]*)>/gi)) {
    const type = (looseAttribute(match[1], "type") ?? "text").toLowerCase();
    const name = looseAttribute(match[1], "name");
    if (!name || ["submit", "button", "image", "reset", "file", "password"].includes(type)) continue;
    if ((type === "checkbox" || type === "radio") && !/\bchecked\b/i.test(match[1])) continue;
    fields.push([name, looseAttribute(match[1], "value") ?? ""]);
  }
  for (const match of form.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = looseAttribute(match[1], "name");
    if (!name) continue;
    const options = [...match[2].matchAll(/<option\b([^>]*)>/gi)];
    const selected = options.find((option) => /\bselected\b/i.test(option[1])) ?? options[0];
    if (selected) fields.push([name, looseAttribute(selected[1], "value") ?? ""]);
  }
  return fields;
}

/** Links on an index page to follow one level down (same host). */
export function followLinks(html: string, pageUrl: string, pattern: RegExp): string[] {
  const host = new URL(pageUrl).hostname;
  const found = new Set<string>();
  for (const anchor of anchorsIn(html, pageUrl)) {
    try {
      if (new URL(anchor.url).hostname === host && pattern.test(anchor.url) && !isDocumentLink(anchor.url)) found.add(anchor.url);
    } catch {
      // ignore
    }
  }
  return [...found];
}
