import { createHash } from "node:crypto";
import type { SourceAdapter, SourceDocument, SourceLanguage } from "./types.js";
import { crawlDelayMs, crawlerUserAgent } from "../lib/tool-config.js";

const DOE_ORIGIN = "https://doe.gov.in";
const LISTINGS = [
  DOE_ORIGIN + "/en/orders-circulars/31",
  DOE_ORIGIN + "/archive/orders-circulars/31",
] as const;
const DEFAULT_MAX_PAGES = 3;
const ABSOLUTE_MAX_PAGES = 20;

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function textContent(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

function linksIn(html: string, pageUrl: string): Array<{ href: string; label: string }> {
  const links: Array<{ href: string; label: string }> = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = match[1].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href) continue;
    try {
      links.push({ href: new URL(decodeEntities(href), pageUrl).href, label: textContent(match[2]) });
    } catch {
      // Ignore malformed links in public-site markup.
    }
  }
  return links;
}

function parseDate(value: string): string | null {
  const dayFirst = value.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (dayFirst) {
    const [, day, month, year] = dayFirst;
    return year + "-" + month.padStart(2, "0") + "-" + day.padStart(2, "0");
  }
  const iso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return iso ? iso[1] + "-" + iso[2] + "-" + iso[3] : null;
}

function guessLanguage(title: string): SourceLanguage {
  const hasDevanagari = /[\u0900-\u097f]/.test(title);
  const hasLatin = /[A-Za-z]/.test(title);
  if (hasDevanagari && hasLatin) return "mixed";
  if (hasDevanagari) return "hi";
  if (hasLatin) return "en";
  return "unknown";
}

function classifyDocument(title: string): string {
  if (/general financial rules|\bgfr\b/i.test(title) && /compilation|updated|updation/i.test(title)) {
    return "gfr-compilation";
  }
  if (/amendment|corrigendum|correction/i.test(title)) return "gfr-amendment";
  if (/guideline|guidelines|instruction|instructions/i.test(title)) return "gfr-guidance";
  return "gfr-related-order";
}

function safeOfficialUrl(value: string, pageUrl: string): string | null {
  try {
    const url = new URL(value, pageUrl);
    if (url.protocol !== "https:" || url.hostname !== "doe.gov.in") return null;
    return url.href;
  } catch {
    return null;
  }
}

function parseListing(html: string, listingUrl: string): SourceDocument[] {
  const documents: SourceDocument[] = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cell[1]);
    if (cells.length < 4) continue;
    const links = linksIn(row[1], listingUrl);
    const download = links.find(({ href, label }) =>
      /\.pdf(?:$|[?#])/i.test(href) || /\b(download|pdf)\b/i.test(label),
    );
    if (!download) continue;
    const downloadUrl = safeOfficialUrl(download.href, listingUrl);
    if (!downloadUrl) continue;

    const title = textContent(cells.length >= 5 ? cells[2] : cells[1]);
    if (!title || /^download|^view$/i.test(title)) continue;
    const goNumber = textContent(cells.length >= 5 ? cells[1] : "") || null;
    const dateText = textContent(cells.length >= 5 ? cells[3] : cells[cells.length - 2]);
    const sourceId = "doe-gfr-" + createHash("sha256").update(downloadUrl).digest("hex").slice(0, 24);
    documents.push({
      sourceId,
      title,
      sourceUrl: downloadUrl,
      downloadUrl,
      listingUrls: [listingUrl],
      issuer: "Department of Expenditure, Ministry of Finance, Government of India",
      jurisdiction: "central",
      department: null,
      documentType: classifyDocument(title),
      goDate: parseDate(dateText),
      goNumber,
      language: guessLanguage(title),
    });
  }
  return documents;
}

function maxPages(): number {
  const configured = Number.parseInt(process.env.DOE_GFR_MAX_PAGES ?? String(DEFAULT_MAX_PAGES), 10);
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_MAX_PAGES;
  return Math.min(configured, ABSOLUTE_MAX_PAGES);
}

function pageNumber(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "doe.gov.in") return null;
    const page = Number.parseInt(parsed.searchParams.get("page") ?? "", 10);
    return Number.isInteger(page) && page >= 0 ? page : null;
  } catch {
    return null;
  }
}

function listingPages(seed: string, html: string): string[] {
  const seedUrl = new URL(seed);
  const basePage = pageNumber(seed) ?? 0;
  const pageLinks = linksIn(html, seed).flatMap(({ href }) => {
    const candidate = new URL(href);
    if (candidate.pathname !== seedUrl.pathname) return [];
    const page = pageNumber(candidate.href);
    return page === null ? [] : [page];
  });
  const highestPage = Math.max(basePage, ...pageLinks);
  const cap = maxPages();
  const pages = new Set<number>([basePage]);
  for (let offset = 1; offset < cap && basePage + offset <= highestPage; offset++) {
    pages.add(basePage + offset);
  }
  return [...pages].map((page) => {
    const url = new URL(seed);
    if (page === 0) url.searchParams.delete("page");
    else url.searchParams.set("page", String(page));
    return url.href;
  });
}

async function delay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, crawlDelayMs()));
}

async function fetchListing(url: string): Promise<{ html: string; url: string }> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": crawlerUserAgent(),
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const finalUrl = new URL(response.url || url);
  if (finalUrl.protocol !== "https:" || finalUrl.hostname !== "doe.gov.in") {
    throw new Error("DOE GFR listing redirected outside doe.gov.in: " + finalUrl.href);
  }
  if (!response.ok) throw new Error("DOE GFR listing returned HTTP " + response.status + ": " + url);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("html")) {
    throw new Error("DOE GFR listing was not HTML (" + (contentType || "unknown content type") + "): " + url);
  }
  return { html: await response.text(), url: finalUrl.href };
}

async function discover(): Promise<SourceDocument[]> {
  const byUrl = new Map<string, SourceDocument>();
  for (const [seedIndex, seed] of LISTINGS.entries()) {
    const firstPage = await fetchListing(seed);
    const pages = listingPages(firstPage.url, firstPage.html);
    for (const [index, pageUrl] of pages.entries()) {
      const listing = index === 0 ? firstPage : await (async () => {
        await delay();
        return fetchListing(pageUrl);
      })();
      for (const document of parseListing(listing.html, listing.url)) {
        const existing = byUrl.get(document.downloadUrl);
        if (existing) {
          if (!existing.listingUrls.includes(listing.url)) existing.listingUrls.push(listing.url);
        } else {
          byUrl.set(document.downloadUrl, document);
        }
      }
    }
    if (seedIndex < LISTINGS.length - 1) await delay();
  }
  if (byUrl.size === 0) {
    throw new Error("No PDF records were found on the DOE GFR listing pages; the site layout may have changed.");
  }
  return [...byUrl.values()];
}

export const doeGfrAdapter: SourceAdapter = {
  id: "doe-gfr",
  collection: "doe-gfr",
  displayName: "Department of Expenditure — General Financial Rules",
  allowedHosts: ["doe.gov.in"],
  discover,
};
