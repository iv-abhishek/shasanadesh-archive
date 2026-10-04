/**
 * Pipeline stage: source discovery — crawled official websites (ADR-097, ADR-103)
 *
 * Purpose:
 *   One generic adapter per approved site in datasets/crawl/sites.json. It
 *   reads the site's listing pages (following plain page links, ASP.NET
 *   GridView pages, and index pages named by followPattern), extracts the
 *   document links with their row details, applies the admission rules, and
 *   hands the admitted documents to ingest-source.ts like any other adapter.
 *
 * Invariants:
 *   - adapter id, collection and provider = "crawl-<site id>"; sourceId =
 *     "crawl-<site id>-<12 hex of the document URL>", stable across runs
 *   - every fetch goes through politeFetch (government hosts, robots.txt,
 *     ≥3 s per host); plain http only for hosts the register writes as http
 *   - listing pages per run are capped (maxPages); no ids are enumerated, only
 *     links the site itself shows are followed
 *   - level, visibility and kind travel in sourceRecord.crawl, so search can
 *     keep district documents away from headquarters officers
 */

import { createHash } from "node:crypto";
import { politeFetch } from "./http.js";
import type { SourceAdapter, SourceDocument } from "./types.js";
import { admit, type Admission } from "../crawl/admission.js";
import { extractItems, followLinks, formFields, pagerOf, type ListingItem } from "../crawl/extract.js";
import { loadRegister, maxPagesFor, siteHosts, visibilityFor, type CrawlSite } from "../crawl/register.js";

export interface CrawlEntry {
  item: ListingItem;
  admission: Admission;
  listingUrl: string;
}

export interface SiteCrawl {
  site: CrawlSite;
  pagesRead: number;
  entries: CrawlEntry[];
  /** Documents on hosts the site may not fetch from (listed for review). */
  offHost: string[];
  errors: string[];
  /** The pager said there were more pages than maxPages allowed. */
  truncated: boolean;
}

const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5";

export function crawlSourceId(siteId: string, url: string): string {
  return `crawl-${siteId}-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
}

/** A small per-site cookie jar: ASP.NET pagers need the session cookie back. */
class CookieJar {
  private cookies = new Map<string, string>();
  take(response: Response): void {
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      if (index > 0) this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }
  header(): Record<string, string> {
    return this.cookies.size ? { Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; ") } : {};
  }
}

export async function crawlSite(site: CrawlSite, options: { maxPages?: number } = {}): Promise<SiteCrawl> {
  const { allowedHosts, httpHosts } = siteHosts(site);
  const docPattern = site.docLinkPattern ? new RegExp(site.docLinkPattern, "i") : undefined;
  const followPattern = site.followPattern ? new RegExp(site.followPattern, "i") : undefined;
  const maxPages = options.maxPages ?? maxPagesFor(site);
  const jar = new CookieJar();
  const result: SiteCrawl = { site, pagesRead: 0, entries: [], offHost: [], errors: [], truncated: false };
  const seenDocs = new Set<string>();
  const seenPages = new Set<string>();

  const fetchHtml = async (url: string, post?: { body: string; referer: string }): Promise<{ html: string; url: string } | null> => {
    try {
      const response = await politeFetch(url, {
        allowedHosts,
        httpHosts,
        accept: HTML_ACCEPT,
        timeoutMs: 60_000,
        ...(post
          ? { method: "POST" as const, body: post.body, headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: post.referer, ...jar.header() } }
          : { headers: jar.header() }),
      });
      jar.take(response);
      if (!response.ok) {
        result.errors.push(`${url}: HTTP ${response.status}`);
        return null;
      }
      const type = response.headers.get("content-type") ?? "";
      if (type && !/html|xml|text\/plain/i.test(type)) {
        result.errors.push(`${url}: not a web page (${type})`);
        return null;
      }
      result.pagesRead++;
      return { html: await response.text(), url: response.url || url };
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      result.errors.push(`${url}: ${cause ?? (error instanceof Error ? error.message : String(error))}`);
      return null;
    }
  };

  const take = (html: string, pageUrl: string) => {
    for (const item of extractItems(html, pageUrl, { docLinkPattern: docPattern, siteLanguage: site.language })) {
      if (seenDocs.has(item.url)) continue;
      seenDocs.add(item.url);
      const parsed = new URL(item.url);
      const host = parsed.hostname;
      // An http link on a site we read over https: fetch the same file over https.
      if (parsed.protocol === "http:" && allowedHosts.includes(host) && !httpHosts.includes(host)) {
        parsed.protocol = "https:";
        item.url = parsed.href;
        if (seenDocs.has(item.url)) continue;
        seenDocs.add(item.url);
      }
      const protocolOk = item.url.startsWith("https:") || httpHosts.includes(host);
      if (!allowedHosts.includes(host) || !protocolOk) {
        result.offHost.push(item.url);
        continue;
      }
      result.entries.push({ item, admission: admit(item, site), listingUrl: pageUrl });
    }
  };

  const queue: string[] = [...site.listingUrls];
  while (queue.length && result.pagesRead < maxPages) {
    const next = queue.shift()!;
    if (seenPages.has(next)) continue;
    seenPages.add(next);
    const page = await fetchHtml(next);
    if (!page) continue;
    seenPages.add(page.url);
    take(page.html, page.url);

    if (followPattern) for (const link of followLinks(page.html, page.url, followPattern)) if (!seenPages.has(link)) queue.push(link);

    const pager = pagerOf(page.html, page.url);
    for (const link of pager.links) if (!seenPages.has(link)) queue.push(link);

    // ASP.NET GridView: post the form back for Page$2, Page$3, … (what clicking the number does).
    if (pager.postBacks.length) {
      const target = pager.postBacks[0].target;
      const lastPage = pager.totalItems && pager.pageSize ? Math.ceil(pager.totalItems / pager.pageSize) : null;
      let state = page.html;
      for (let number = 2; ; number++) {
        if (lastPage !== null && number > lastPage) break;
        if (result.pagesRead >= maxPages) {
          result.truncated = true;
          break;
        }
        const fields = formFields(state).filter(([name]) => name !== "__EVENTTARGET" && name !== "__EVENTARGUMENT");
        const body = new URLSearchParams([["__EVENTTARGET", target], ["__EVENTARGUMENT", `Page$${number}`], ...fields]).toString();
        const before = result.entries.length + result.offHost.length;
        const posted = await fetchHtml(page.url, { body, referer: page.url });
        if (!posted) break;
        take(posted.html, page.url);
        state = posted.html;
        // No new documents: the pager has run out (or ignored us); stop.
        if (result.entries.length + result.offHost.length === before) break;
        if (lastPage === null && !pagerOf(posted.html, page.url).postBacks.some((postBack) => postBack.argument === `Page$${number + 1}` || postBack.argument === "Page$Next")) break;
      }
    }
  }
  if (queue.length) result.truncated = true;
  return result;
}

function jurisdictionOf(site: CrawlSite): "central" | "state" {
  return site.level === "central" ? "central" : "state";
}

export function toSourceDocument(site: CrawlSite, entry: CrawlEntry): SourceDocument {
  const { item, admission, listingUrl } = entry;
  return {
    sourceId: crawlSourceId(site.id, item.url),
    title: item.title,
    sourceUrl: item.url,
    downloadUrl: item.url,
    listingUrls: [listingUrl],
    issuer: site.name,
    jurisdiction: jurisdictionOf(site),
    department: site.department,
    documentType: admission.kind,
    goDate: item.date,
    goNumber: item.goNumber,
    language: item.language,
    sourceRecord: {
      crawl: {
        site: site.id,
        level: site.level,
        visibility: visibilityFor(site.level),
        kind: admission.kind,
        priority: site.priority,
      },
      linkLabel: item.linkLabel,
      cells: item.cells,
    },
  };
}

export function crawlAdapterFor(site: CrawlSite): SourceAdapter {
  const { allowedHosts, httpHosts } = siteHosts(site);
  return {
    id: `crawl-${site.id}`,
    collection: `crawl-${site.id}`,
    displayName: `${site.name} (crawled)`,
    allowedHosts,
    httpHosts,
    async discover() {
      const crawl = await crawlSite(site);
      for (const error of crawl.errors) console.error("  listing problem: " + error);
      const kept = crawl.entries.filter((entry) => entry.admission.admitted);
      console.log(`  ${site.id}: ${crawl.pagesRead} listing pages, ${crawl.entries.length} documents, ${kept.length} admitted`);
      return kept.map((entry) => toSourceDocument(site, entry));
    },
  };
}

/** Adapters for approved sites not already covered by a dedicated adapter. */
export function crawlAdapters(): SourceAdapter[] {
  try {
    return loadRegister().sites.filter((site) => site.approved && !site.coveredBy).map(crawlAdapterFor);
  } catch {
    return [];
  }
}
