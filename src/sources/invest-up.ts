/**
 * Pipeline stage: source discovery
 *
 * Purpose:
 *   Discover orders and notifications published by Invest UP (the state's
 *   investment promotion agency, Infrastructure and Industrial Development
 *   Department) on invest.up.gov.in.
 *
 * Source quirks:
 *   - /gos/ is a paginated table (?pagenum=N, ~10 rows per page, about 40
 *     pages). Most rows are orders on revision petitions against industrial
 *     development authorities (NOIDA, GNIDA, YEIDA, UPSIDA) under the UP
 *     Industrial Area Development Act; a few are general GOs.
 *   - Some rows carry an invalid date ("November 30, -0001"); those get no date
 *     rather than a wrong one.
 *   - /notifications/ is a card list (rules and notifications) with a date,
 *     title, size and language line per card.
 *
 * Invariants:
 *   - downloads stay on https://invest.up.gov.in
 *   - INVEST_UP_MAX_PAGES bounds the number of /gos/ pages read per run
 */

import { createHash } from "node:crypto";
import type { SourceAdapter, SourceDocument } from "./types.js";
import { politeFetch } from "./http.js";
import { anchors, attribute, guessLanguage, parseEnglishLongDate, textContent } from "./html.js";

const HOST = "invest.up.gov.in";
const ORIGIN = "https://" + HOST;
const ISSUER = "Invest UP, Infrastructure and Industrial Development Department, Uttar Pradesh";
const DEPARTMENT = "Infrastructure and Industrial Development";
const ABSOLUTE_MAX_PAGES = 100;

function idFor(url: string): string {
  return "invest-up-" + createHash("sha256").update(url).digest("hex").slice(0, 20);
}

function officialPdf(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol === "http:" && url.hostname === HOST) url.protocol = "https:";
    return url.hostname === HOST && /\.pdf$/i.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

function classify(title: string): string {
  if (/revision|appellate|petition|appeal|hearing|withdrawal|dismissal/i.test(title)) return "revision-order";
  return "government-order";
}

/** Rows of the /gos/ table. */
export function parseGoPage(html: string, pageUrl: string): SourceDocument[] {
  const documents: SourceDocument[] = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const link = anchors(row[1], pageUrl).find((candidate) => officialPdf(candidate.href));
    if (!link) continue;
    const downloadUrl = officialPdf(link.href)!;
    const dateText = row[1].match(/lblorderDate_\d+"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "";
    const typeText = textContent(row[1].match(/lbtype_\d+"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
    const title = link.label;
    if (!title) continue;
    documents.push({
      sourceId: idFor(downloadUrl),
      title,
      sourceUrl: downloadUrl,
      downloadUrl,
      listingUrls: [pageUrl],
      issuer: ISSUER,
      jurisdiction: "state",
      department: DEPARTMENT,
      documentType: classify(title),
      goDate: parseEnglishLongDate(textContent(dateText)),
      goNumber: null,
      language: guessLanguage(title),
      sourceRecord: { listing: "gos", orderDateText: textContent(dateText), typeText: typeText || null },
    });
  }
  return documents;
}

/** Cards on /notifications/. */
export function parseNotifications(html: string, pageUrl: string): SourceDocument[] {
  const documents: SourceDocument[] = [];
  const blocks = html.split(/<div class="edwrap">/i).slice(1);
  for (const block of blocks) {
    const link = anchors(block, pageUrl).find((candidate) => officialPdf(candidate.href));
    if (!link) continue;
    const downloadUrl = officialPdf(link.href)!;
    const title = textContent(block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? "");
    if (!title) continue;
    const month = textContent(block.match(/class="month"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "");
    const dateBlock = block.match(/class="date"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "";
    const year = textContent(dateBlock.match(/class="year"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
    const day = textContent(dateBlock.replace(/<span[\s\S]*$/i, ""));
    const sizeLine = textContent(block.match(/class="pdf-size"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
    const stated = sizeLine.match(/Language:\s*([A-Za-z]+)/i)?.[1] ?? null;
    documents.push({
      sourceId: idFor(downloadUrl),
      title,
      sourceUrl: downloadUrl,
      downloadUrl,
      listingUrls: [pageUrl],
      issuer: ISSUER,
      jurisdiction: "state",
      department: DEPARTMENT,
      documentType: "notification",
      goDate: parseEnglishLongDate(`${month} ${day}, ${year}`),
      goNumber: null,
      language: stated?.toLowerCase() === "english" ? "en" : stated?.toLowerCase() === "hindi" ? "hi" : guessLanguage(title),
      sourceRecord: { listing: "notifications", sizeLine, statedLanguage: stated, linkTitle: attribute(block, "title") },
    });
  }
  return documents;
}

/** Highest ?pagenum= linked from the first /gos/ page. */
export function lastGoPage(html: string): number {
  const pages = [...html.matchAll(/[?&]pagenum=(\d+)/g)].map((match) => Number(match[1]));
  return Math.max(1, ...pages);
}

function maxPages(): number {
  const configured = Number.parseInt(process.env.INVEST_UP_MAX_PAGES ?? "", 10);
  return Number.isInteger(configured) && configured > 0 ? Math.min(configured, ABSOLUTE_MAX_PAGES) : ABSOLUTE_MAX_PAGES;
}

async function fetchHtml(url: string): Promise<string> {
  const response = await politeFetch(url, { allowedHosts: [HOST] });
  if (!response.ok) throw new Error(`Invest UP returned HTTP ${response.status} for ${url}`);
  return response.text();
}

async function discover(): Promise<SourceDocument[]> {
  const byUrl = new Map<string, SourceDocument>();
  const add = (documents: SourceDocument[]) => {
    for (const document of documents) {
      const existing = byUrl.get(document.downloadUrl);
      if (existing) {
        for (const listing of document.listingUrls) {
          if (!existing.listingUrls.includes(listing)) existing.listingUrls.push(listing);
        }
      } else {
        byUrl.set(document.downloadUrl, document);
      }
    }
  };

  const firstUrl = ORIGIN + "/gos/";
  const first = await fetchHtml(firstUrl);
  add(parseGoPage(first, firstUrl));
  const last = Math.min(lastGoPage(first), maxPages());
  for (let page = 2; page <= last; page++) {
    const url = `${ORIGIN}/gos/?pagenum=${page}`;
    add(parseGoPage(await fetchHtml(url), url));
  }

  const notificationsUrl = ORIGIN + "/notifications/";
  add(parseNotifications(await fetchHtml(notificationsUrl), notificationsUrl));

  if (byUrl.size === 0) throw new Error("No Invest UP orders were found; the site layout may have changed.");
  return [...byUrl.values()];
}

export const investUpAdapter: SourceAdapter = {
  id: "invest-up",
  collection: "invest-up",
  displayName: "Invest UP — Government Orders, revision orders and notifications",
  allowedHosts: [HOST],
  discover,
};
