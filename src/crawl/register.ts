/**
 * Pipeline stage: crawl register (ADR-097, ADR-103)
 *
 * Purpose:
 *   Read datasets/crawl/sites.json, the owner-reviewed list of official
 *   websites the crawler may read, and check every entry before it is used.
 *
 * Invariants:
 *   - only government hosts (lib/government-hosts.ts); a site on another
 *     domain is refused until its host is added there by hand
 *   - a site is crawled only when "approved": true; the dry run (crawl:check)
 *     may read listing pages of any site so the owner can decide
 *   - plain http is allowed only for a host whose listing URL in the register
 *     is written with http:// (reviewed per site)
 *   - a site already read by a dedicated adapter ("coveredBy") is skipped
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { isGovernmentHost } from "../lib/government-hosts.js";

export type CrawlLevel = "central" | "state-hq" | "directorate" | "division" | "district";

export interface CrawlSite {
  id: string;
  name: string;
  level: CrawlLevel;
  department: string | null;
  listingUrls: string[];
  docTypes: string[];
  language: "hi" | "en" | "both";
  platform: string;
  verified: boolean;
  priority: number;
  approved: boolean;
  notes?: string;
  /** Regex (string) for document links that do not end in .pdf (e.g. "ViewDoc\\.aspx\\?id=\\d+"). */
  docLinkPattern?: string;
  /** Regex (string) for index links to follow one level down (e.g. volume pages). */
  followPattern?: string;
  /** Most listing pages read per run (pager pages and followed index pages together). */
  maxPages?: number;
  /** Other government hosts the site's documents live on. */
  fileHosts?: string[];
  /** Adapter id that already reads this site; the crawler leaves it alone. */
  coveredBy?: string;
}

export interface SiteProblem {
  site: string;
  problem: string;
}

const LEVELS: CrawlLevel[] = ["central", "state-hq", "directorate", "division", "district"];
export const DEFAULT_MAX_PAGES = 20;
const ABSOLUTE_MAX_PAGES = 200;
export const REGISTER_FILE = path.resolve("datasets/crawl/sites.json");

export function loadRegister(file = REGISTER_FILE): { sites: CrawlSite[]; problems: SiteProblem[] } {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { sites: CrawlSite[] };
  const sites: CrawlSite[] = [];
  const problems: SiteProblem[] = [];
  const seen = new Set<string>();
  for (const site of raw.sites) {
    const problem = checkSite(site, seen);
    if (problem) problems.push({ site: site.id, problem });
    else sites.push(site);
    seen.add(site.id);
  }
  return { sites, problems };
}

function checkSite(site: CrawlSite, seen: Set<string>): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(site.id)) return "id must be 2-41 lowercase letters, digits and dashes";
  if (seen.has(site.id)) return "duplicate id";
  if (!LEVELS.includes(site.level)) return `level must be one of ${LEVELS.join(", ")}`;
  if (!site.listingUrls?.length) return "no listing URLs";
  for (const value of [...site.listingUrls, ...(site.fileHosts ?? []).map((host) => `https://${host}/`)]) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return `bad URL ${value}`;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return `bad protocol ${value}`;
    if (!isGovernmentHost(url.hostname)) return `${url.hostname} is not on the government host list (lib/government-hosts.ts); add it there after review`;
  }
  for (const pattern of [site.docLinkPattern, site.followPattern]) {
    if (!pattern) continue;
    try {
      new RegExp(pattern, "i");
    } catch {
      return `bad pattern ${pattern}`;
    }
  }
  return null;
}

/** Hosts a site may fetch from, and those of them allowed over plain http. */
export function siteHosts(site: CrawlSite): { allowedHosts: string[]; httpHosts: string[] } {
  const allowed = new Set<string>(site.fileHosts ?? []);
  const http = new Set<string>();
  for (const value of site.listingUrls) {
    const url = new URL(value);
    allowed.add(url.hostname);
    // "www." and bare host serve the same site on most NIC hosts.
    allowed.add(url.hostname.startsWith("www.") ? url.hostname.slice(4) : "www." + url.hostname);
    if (url.protocol === "http:") {
      http.add(url.hostname);
      http.add(url.hostname.startsWith("www.") ? url.hostname.slice(4) : "www." + url.hostname);
    }
  }
  const allowedHosts = [...allowed].filter((host) => isGovernmentHost(host));
  return { allowedHosts, httpHosts: [...http].filter((host) => allowedHosts.includes(host)) };
}

export function maxPagesFor(site: CrawlSite): number {
  return Math.min(ABSOLUTE_MAX_PAGES, Math.max(1, site.maxPages ?? DEFAULT_MAX_PAGES));
}

/** Headquarters officers see central, state and directorate documents; district ones only when asked (KNOWLEDGE_SOURCES.md). */
export function visibilityFor(level: CrawlLevel): "all" | "district" {
  return level === "district" || level === "division" ? "district" : "all";
}
