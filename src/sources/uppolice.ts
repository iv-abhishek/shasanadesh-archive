/**
 * Pipeline stage: source discovery
 *
 * Purpose:
 *   Discover the Government Orders, notifications and rule books linked from
 *   UP Police's "शासनादेश / Government Orders" page on uppolice.gov.in.
 *
 * Source quirks:
 *   - One server-rendered table; the Hindi (/article/hi/gov-order) and English
 *     (/article/en/gov-order) pages link the same PDFs with titles in each
 *     language. Both are read and merged per PDF, keeping both titles.
 *   - Links are relative to <base href='https://uppolice.gov.in'> and some
 *     contain raw spaces or Devanagari; new URL() normalises them so the same
 *     PDF is not archived twice.
 *   - The table has no dates or order numbers. An English title's
 *     "dated DD-MM-YYYY" is used when present; the upload timestamp that
 *     prefixes many file names (e.g. 20201210114941…) is kept in sourceRecord
 *     as a hint only, never as the order date.
 *   - Links to other sites (shasanadesh.up.gov.in, legislative.gov.in,
 *     ndal-alis.gov.in) are skipped; Shasanadesh has its own importer.
 *
 * Invariants:
 *   - downloads stay on https://uppolice.gov.in
 */

import { createHash } from "node:crypto";
import type { SourceAdapter, SourceDocument } from "./types.js";
import { politeFetch } from "./http.js";
import { anchors, attribute, guessLanguage, parseDayFirstDate } from "./html.js";

const HOST = "uppolice.gov.in";
const ORIGIN = "https://" + HOST;
const LISTINGS = { hi: ORIGIN + "/article/hi/gov-order", en: ORIGIN + "/article/en/gov-order" } as const;
const ISSUER = "Uttar Pradesh Police Headquarters";
const DEPARTMENT = "Home (Police)";

function idFor(url: string): string {
  return "uppolice-" + createHash("sha256").update(url).digest("hex").slice(0, 20);
}

function baseHref(html: string, fallback: string): string {
  const tag = html.match(/<base\b[^>]*>/i)?.[0];
  const href = tag ? attribute(tag, "href") : null;
  // "https://uppolice.gov.in" without a trailing slash still resolves
  // "site/…" against the site root.
  return href ? (href.endsWith("/") ? href : href + "/") : fallback;
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
  if (/notification|अधिसूचना|नोटिफिकेशन/i.test(title)) return "notification";
  if (/writ|रिट|याचिका|high court|उच्च न्यायालय/i.test(title)) return "court-compliance-order";
  if (/नियमावली|rules|हस्तपुस्तिका|दिग्दर्शिका|manual|book/i.test(title)) return "rules-manual";
  return "government-order";
}

export interface ListingLink {
  url: string;
  title: string;
}

/** PDF links in the page's content table. */
export function parseGovOrderTable(html: string, pageUrl: string): ListingLink[] {
  const start = html.search(/<table\b/i);
  if (start < 0) return [];
  const end = html.indexOf("</table>", start);
  const table = html.slice(start, end < 0 ? undefined : end);
  const base = baseHref(html, pageUrl);
  return anchors(table, base).flatMap(({ href, label }) => {
    const url = officialPdf(href);
    return url && label ? [{ url, title: label }] : [];
  });
}

/** Merge the Hindi and English listings into one document per PDF. */
export function mergeListings(hindi: ListingLink[], english: ListingLink[]): SourceDocument[] {
  const byUrl = new Map<string, { hi?: string; en?: string; listings: string[] }>();
  for (const [language, links, listing] of [
    ["hi", hindi, LISTINGS.hi],
    ["en", english, LISTINGS.en],
  ] as const) {
    for (const link of links) {
      const entry = byUrl.get(link.url) ?? { listings: [] };
      entry[language] ??= link.title;
      if (!entry.listings.includes(listing)) entry.listings.push(listing);
      byUrl.set(link.url, entry);
    }
  }

  return [...byUrl.entries()].map(([url, entry]) => {
    const title = entry.hi ?? entry.en ?? url;
    const fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    const uploadStamp = fileName.match(/^(\d{4})(\d{2})(\d{2})\d{6,}/);
    const datedInTitle = [entry.en, entry.hi].map((value) => value?.match(/dated\s+([\d./-]+)/i)?.[1]).find(Boolean);
    return {
      sourceId: idFor(url),
      title,
      sourceUrl: url,
      downloadUrl: url,
      listingUrls: entry.listings,
      issuer: ISSUER,
      jurisdiction: "state" as const,
      department: DEPARTMENT,
      documentType: classify(`${entry.hi ?? ""} ${entry.en ?? ""}`),
      goDate: datedInTitle ? parseDayFirstDate(datedInTitle) : null,
      goNumber: entry.en?.match(/\bNo\.?\s*([0-9][\w/()-]+)/i)?.[1] ?? null,
      language: guessLanguage(title),
      titles: { hi: entry.hi ?? null, en: entry.en ?? null },
      sourceRecord: {
        fileName,
        uploadDateHint: uploadStamp ? `${uploadStamp[1]}-${uploadStamp[2]}-${uploadStamp[3]}` : null,
      },
    };
  });
}

async function fetchHtml(url: string): Promise<string> {
  const response = await politeFetch(url, { allowedHosts: [HOST] });
  if (!response.ok) throw new Error(`UP Police returned HTTP ${response.status} for ${url}`);
  return response.text();
}

async function discover(): Promise<SourceDocument[]> {
  const hindi = parseGovOrderTable(await fetchHtml(LISTINGS.hi), LISTINGS.hi);
  const english = parseGovOrderTable(await fetchHtml(LISTINGS.en), LISTINGS.en);
  const documents = mergeListings(hindi, english);
  if (documents.length === 0) throw new Error("No UP Police orders were found; the page layout may have changed.");
  return documents;
}

export const upPoliceAdapter: SourceAdapter = {
  id: "uppolice",
  collection: "uppolice",
  displayName: "UP Police — Government Orders, notifications and rule books",
  allowedHosts: [HOST],
  discover,
};
