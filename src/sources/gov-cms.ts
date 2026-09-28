/**
 * Pipeline stage: source discovery — ministry sites on the common government CMS
 *
 * Purpose:
 *   Many Government of India ministries now run the same website platform
 *   (Next.js front end, WordPress back end, e.g. सूक्ष्मलघुऔरमध्यमउद्यममंत्रालय.सरकार.भारत
 *   for MSME). Its public JSON lists documents by category ("orders-and-notices",
 *   "acts-and-policy", "guidelines", …) for current ("publish") and archived
 *   ("archive") items; each item points to attachment records that carry the
 *   PDF URL on the ministry's own host (msme.gov.in/static/uploads/…).
 *   datasets/gov-cms/sites.json says which ministries and categories to read.
 *
 * Invariants:
 *   - only the configured origin and file hosts are fetched (government hosts,
 *     politeFetch: robots.txt, crawl delay); no API key or login is used
 *   - sourceId = "<site>-<post id>[-hi|-en]", stable across runs; collection
 *     and provider = "gov-cms-<site>" (B2 archive/gov-cms-<site>/…)
 *   - the listing record and the attachment record are kept in sourceRecord
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { politeFetch } from "./http.js";
import type { SourceAdapter, SourceDocument, SourceLanguage } from "./types.js";
import { isGovernmentHost } from "../lib/government-hosts.js";

interface SiteCategory {
  slug: string;
  page: string;
  documentType: string;
}

export interface GovCmsSite {
  id: string;
  name: string;
  issuer: string;
  origin: string;
  displayOrigin?: string;
  fileHosts: string[];
  categories: SiteCategory[];
  statuses: Array<"publish" | "archive">;
}

interface ListingPost {
  ID: number;
  post_title: string;
  post_name: string;
  acf_data?: { date?: string; file?: Array<{ external_link?: string; file?: number[] }> };
}

interface Attachment {
  url: string;
  filesize?: number;
  filename?: string;
}

const PAGE_SIZE = 50;
const ACCEPT_JSON = "application/json";

export function loadSites(file = path.resolve("datasets/gov-cms/sites.json")): GovCmsSite[] {
  const sites = (JSON.parse(readFileSync(file, "utf8")) as { sites: GovCmsSite[] }).sites;
  for (const site of sites) {
    const origin = new URL(site.origin);
    if (origin.protocol !== "https:" || !isGovernmentHost(origin.hostname)) throw new Error(`gov-cms site ${site.id}: origin must be an HTTPS government host`);
    for (const host of site.fileHosts) if (!isGovernmentHost(host)) throw new Error(`gov-cms site ${site.id}: file host ${host} is not a government host`);
    if (!/^[a-z0-9-]+$/.test(site.id)) throw new Error(`gov-cms site id "${site.id}" must be lowercase letters, digits and dashes`);
  }
  return sites;
}

/** "21/09/2026" → "2026-09-21". */
export function isoDate(value: string | null | undefined): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((value ?? "").trim());
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

function languageOf(key: string, languages: string[]): SourceLanguage {
  if (key === "pdf_hindi" || (languages.length === 1 && /hindi/i.test(languages[0]))) return "hi";
  if (key === "pdf_english" || (languages.length === 1 && /english/i.test(languages[0]))) return "en";
  if (key === "pdf_both") return "mixed";
  return "unknown";
}

async function getJson<T>(site: GovCmsSite, pathAndQuery: string): Promise<T> {
  const hosts = [new URL(site.origin).hostname];
  const response = await politeFetch(`${site.origin}/cms/wp-json/${pathAndQuery}`, { allowedHosts: hosts, accept: ACCEPT_JSON, timeoutMs: 60_000 });
  if (!response.ok) throw new Error(`${site.id}: ${pathAndQuery} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function listCategory(site: GovCmsSite, category: SiteCategory, status: string): Promise<ListingPost[]> {
  const posts: ListingPost[] = [];
  for (let page = 1; page < 200; page++) {
    const data = await getJson<{ posts?: ListingPost[]; total_pages?: number }>(
      site,
      `document/documents?document_category=${encodeURIComponent(category.slug)}&limit=${PAGE_SIZE}&page=${page}&post_status=${status}&sort=acf&order=DESC&search=`,
    );
    posts.push(...(data.posts ?? []));
    if (!data.total_pages || page >= data.total_pages) break;
  }
  return posts;
}

/** Attachment records of one listing file id: { key: "pdf" | "pdf_hindi" | …, attachment }. */
async function attachments(site: GovCmsSite, fileId: number): Promise<Array<{ key: string; languages: string[]; fileDate: string | null; attachment: Attachment }>> {
  const data = await getJson<{ posts?: { acf_data?: Record<string, unknown> } }>(site, `post-page/post?id=${fileId}`);
  const acf = data.posts?.acf_data ?? {};
  const languages = Array.isArray(acf.language) ? (acf.language as string[]) : [];
  const fileDate = typeof acf.file_date === "string" ? acf.file_date : null;
  return Object.entries(acf)
    .filter(([, value]) => value && typeof value === "object" && typeof (value as Attachment).url === "string")
    .map(([key, value]) => ({ key, languages, fileDate, attachment: value as Attachment }));
}

export async function discoverSite(site: GovCmsSite): Promise<SourceDocument[]> {
  const documents: SourceDocument[] = [];
  const seen = new Set<string>();
  for (const category of site.categories) {
    for (const status of site.statuses) {
      const listingPage = `${site.displayOrigin ?? site.origin}/${status === "archive" ? "archives" : "documents"}?page=${category.page}`;
      for (const post of await listCategory(site, category, status)) {
        const files = (post.acf_data?.file ?? []).flatMap((file) => file.file ?? []);
        const found: Array<{ key: string; languages: string[]; fileDate: string | null; attachment: Attachment }> = [];
        for (const fileId of files) found.push(...(await attachments(site, fileId)));
        const pdfs = found.filter(({ attachment }) => {
          try {
            const url = new URL(attachment.url);
            return url.protocol === "https:" && site.fileHosts.includes(url.hostname) && /\.pdf$/i.test(url.pathname);
          } catch {
            return false;
          }
        });
        for (const { key, languages, fileDate, attachment } of pdfs) {
          const language = languageOf(key, languages);
          const suffix = pdfs.length > 1 ? (language === "hi" ? "-hi" : language === "en" ? "-en" : `-${key}`) : "";
          const sourceId = `${site.id}-${post.ID}${suffix}`;
          if (seen.has(sourceId)) continue;
          seen.add(sourceId);
          documents.push({
            sourceId,
            title: post.post_title.trim(),
            sourceUrl: attachment.url,
            downloadUrl: attachment.url,
            listingUrls: [listingPage],
            issuer: site.issuer,
            jurisdiction: "central",
            department: null,
            documentType: category.documentType,
            goDate: isoDate(fileDate) ?? isoDate(post.acf_data?.date),
            goNumber: null,
            language,
            titles: { en: language === "hi" ? null : post.post_title.trim(), hi: null },
            relatedSourceIds: pdfs.length > 1 ? pdfs.map((other) => `${site.id}-${post.ID}-${languageOf(other.key, other.languages) === "hi" ? "hi" : languageOf(other.key, other.languages) === "en" ? "en" : other.key}`).filter((id) => id !== sourceId) : undefined,
            sourceRecord: { site: site.id, category: category.slug, status, listing: post, attachmentKey: key, fileDate },
          });
        }
      }
    }
  }
  return documents;
}

export function govCmsAdapters(sites = (() => { try { return loadSites(); } catch { return []; } })()): SourceAdapter[] {
  return sites.map((site) => ({
    id: `gov-cms-${site.id}`,
    collection: `gov-cms-${site.id}`,
    displayName: `${site.name} (ministry website)`,
    allowedHosts: [new URL(site.origin).hostname, ...site.fileHosts],
    discover: () => discoverSite(site),
  }));
}
