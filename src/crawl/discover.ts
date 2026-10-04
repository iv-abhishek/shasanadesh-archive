/**
 * Pipeline stage: crawl — finding sites for the register (ADR-103)
 *
 * Purpose:
 *   Grow datasets/crawl/sites.json from the Government of India web directory
 *   (IGOD, igod.gov.in), which lists every UP department, directorate, board,
 *   commission and district site, and every Union ministry. For each listed
 *   site not yet in the register, read its home page, look for the pages that
 *   list orders (शासनादेश, GOs, circulars, notifications, acts/rules), and test
 *   them with the listing reader. Sites with a working listing are added to
 *   the register with "approved": false for the owner to review.
 *
 * Usage:
 *   npm run crawl:discover                      (UP sites + Union ministries; not districts)
 *   npm run crawl:discover -- --dry             (report only; register unchanged)
 *   npm run crawl:discover -- --limit 20 [--skip 40] --districts
 *
 * Invariants:
 *   - reads only the directory's own pages (the "load more" link it uses) and
 *     each site's home page plus at most 3 candidate listing pages
 *   - government hosts only; other domains are listed in the report for review
 *   - never sets "approved": true; existing register entries are not changed
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { politeFetch } from "../sources/http.js";
import { textContent } from "../sources/html.js";
import { isGovernmentHost } from "../lib/government-hosts.js";
import { extractItems } from "./extract.js";
import { REGISTER_FILE, type CrawlLevel, type CrawlSite } from "./register.js";

interface DirectoryEntry {
  name: string;
  url: string;
  host: string;
  category: string;
  scope: "UP" | "IN";
}

interface Proposal {
  entry: DirectoryEntry;
  listings: Array<{ url: string; label: string; documents: number }>;
  problem?: string;
}

const IGOD = "https://igod.gov.in";
const IGOD_HOSTS = ["igod.gov.in"];
// IGOD category codes for UP → register level.
const UP_LEVELS: Record<string, CrawlLevel> = {
  SPMA: "state-hq",
  E003: "state-hq",
  E004: "directorate",
  E005: "directorate",
  E009: "directorate",
  E011: "directorate",
  E013: "directorate",
  E042: "directorate",
  E051: "district",
  E059: "directorate",
  OTHR: "directorate",
};
const CENTRAL_CATEGORIES = ["E002"]; // Union ministries / departments
const SKIP_HOSTS = /(^|\.)(india\.gov\.in|igod\.gov\.in|mygov\.in|nic\.in|s3waas\.gov\.in|data\.gov\.in|pgportal\.gov\.in|passportindia\.gov\.in|digitalindia\.gov\.in)$/;
const LISTING_WORDS =
  /governmentorders|archivegovernmentorders|government[-_ ]?orders?|\bg\.?o\.?s?\b|शासनादेश|circulars?|परिपत्र|notifications?|अधिसूचना|acts?[-_ &]*(and[-_ ])?rules|नियमावली|orders?[-_ ]?(and[-_ ])?circulars|office[-_ ]memorand|guidelines|दिशा-?\s?निर्देश|policies|नीतियाँ/i;
const NOT_LISTING = /website[-_ ]?polic|tender|निविदा|recruitment|भर्ती|result|gallery|news|event|press|rti|contact|feedback|sitemap|login|\.pdf$/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function bare(host: string): string {
  return host.replace(/^www\./, "");
}

async function igodPage(pathname: string, referer?: string): Promise<string> {
  const response = await politeFetch(IGOD + pathname, {
    allowedHosts: IGOD_HOSTS,
    timeoutMs: 60_000,
    // The "load more" endpoint answers only the page's own scroll request.
    ...(referer ? { headers: { "X-Requested-With": "XMLHttpRequest", Referer: IGOD + referer } } : {}),
  });
  if (!response.ok) throw new Error(`IGOD ${pathname}: HTTP ${response.status}`);
  return response.text();
}

function organisations(html: string, category: string, scope: "UP" | "IN"): DirectoryEntry[] {
  const found: DirectoryEntry[] = [];
  for (const match of html.matchAll(/<a\s+href="([^"]+)"\s+class="search-title"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const host = hostOf(match[1]);
    if (!host) continue;
    found.push({ name: textContent(match[2]), url: match[1], host, category, scope });
  }
  return found;
}

/** Every organisation in one IGOD category, including the ones its page loads on scroll. */
async function category(prefix: string, code: string, scope: "UP" | "IN"): Promise<DirectoryEntry[]> {
  const html = await igodPage(`${prefix}/${code}/organizations`);
  const entries = organisations(html, code, scope);
  // The page loads the rest on scroll from the URL its own script names.
  const count = Number(html.match(/var count='(\d+)'/)?.[1] ?? 0);
  const first = Number(html.match(/items_on_first_page = '(\d+)'/)?.[1] ?? entries.length);
  const moreUrl = html.match(/'\/'\+'(organizations(?:_list)?_more)\/'/)?.[1] ?? "organizations_more";
  const perPage = Number(html.match(/per_page = '(\d+)'/)?.[1] ?? 5);
  for (let start = first; start < count; start += perPage) {
    const limit = Math.min(perPage, count - start);
    const more = await igodPage(`${prefix}/${code}/${moreUrl}/${start}/${limit}`, `${prefix}/${code}/organizations`);
    const batch = organisations(more, code, scope);
    if (!batch.length) break;
    entries.push(...batch);
  }
  return entries;
}

export async function readDirectory(options: { districts: boolean }): Promise<DirectoryEntry[]> {
  const all: DirectoryEntry[] = [];
  for (const code of Object.keys(UP_LEVELS)) {
    if (code === "E051" && !options.districts) continue;
    all.push(...(await category("/sg/UP", code, "UP")));
  }
  for (const code of CENTRAL_CATEGORIES) all.push(...(await category("/ug", code, "IN")));
  const seen = new Set<string>();
  return all.filter((entry) => {
    const key = bare(entry.host);
    // IGOD's UP lists include a few other states' portals (e.g. *.ap.gov.in).
    const otherState = entry.scope === "UP" && /\.(ap|tn|kar|karnataka|kerala|mp|rajasthan|delhi|hr|haryana|punjab|bihar|wb|gujarat|maharashtra|telangana|odisha|assam|uk|uttarakhand)\.gov\.in$/.test(entry.host);
    if (seen.has(key) || SKIP_HOSTS.test(entry.host) || otherState) return false;
    seen.add(key);
    return true;
  });
}

async function probe(entry: DirectoryEntry): Promise<Proposal> {
  const hosts = [entry.host, entry.host.startsWith("www.") ? bare(entry.host) : "www." + entry.host];
  const httpHosts = entry.url.startsWith("http:") ? hosts : [];
  const fetchPage = async (url: string) => {
    const response = await politeFetch(url, { allowedHosts: hosts, httpHosts, timeoutMs: 30_000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { html: await response.text(), url: response.url || url };
  };
  try {
    const home = await fetchPage(entry.url);
    const candidates = new Map<string, string>();
    for (const match of home.html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const href = match[1].match(/\bhref\s*=\s*["']?([^"'\s>]+)/i)?.[1];
      if (!href || /^(javascript:|mailto:|#)/i.test(href)) continue;
      let url: URL;
      try {
        url = new URL(href, home.url);
      } catch {
        continue;
      }
      const label = textContent(match[2]);
      const text = `${url.pathname}${url.search} ${label}`;
      if (!hosts.includes(url.hostname) || !LISTING_WORDS.test(text) || NOT_LISTING.test(url.pathname) || NOT_LISTING.test(label)) continue;
      url.hash = "";
      if (!candidates.has(url.href)) candidates.set(url.href, label);
    }
    const listings: Proposal["listings"] = [];
    for (const [url, label] of [...candidates].slice(0, 3)) {
      try {
        const page = await fetchPage(url);
        const documents = extractItems(page.html, page.url).length;
        if (documents >= 3) listings.push({ url, label, documents });
      } catch {
        // A candidate that does not open is simply not proposed.
      }
    }
    return { entry, listings };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return { entry, listings: [], problem: cause ?? (error instanceof Error ? error.message : String(error)) };
  }
}

function siteId(entry: DirectoryEntry, taken: Set<string>): string {
  const base = bare(entry.host)
    .replace(/\.(gov|nic|up)\.in$|\.gov\.in$|\.nic\.in$|\.in$/g, "")
    .replace(/\.up$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  const stem = `${entry.scope === "IN" ? "in-" : ""}${base || "site"}`;
  let id = stem;
  for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`;
  taken.add(id);
  return id;
}

async function pool<T, R>(items: T[], size: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index], index);
      }
    }),
  );
  return results;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const districts = args.includes("--districts");
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : undefined;

  const register = JSON.parse(await readFile(REGISTER_FILE, "utf8")) as { _about: string; sites: Array<CrawlSite & { source?: string }> };
  const known = new Set(register.sites.flatMap((site) => site.listingUrls.map((url) => bare(hostOf(url) ?? ""))));

  console.log("Reading the IGOD directory …");
  const directory = await readDirectory({ districts });
  const outDir = path.resolve("data/crawl");
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "directory-igod.json"), JSON.stringify(directory, null, 2) + "\n");
  const fresh = directory.filter((entry) => !known.has(bare(entry.host)));
  const government = fresh.filter((entry) => isGovernmentHost(entry.host));
  const otherDomains = fresh.filter((entry) => !isGovernmentHost(entry.host));
  const skipIndex = args.indexOf("--skip");
  const skip = skipIndex >= 0 ? Number(args[skipIndex + 1]) : 0;
  const toProbe = government.slice(skip, limit ? skip + limit : undefined);
  console.log(`${directory.length} sites listed · ${fresh.length} not in the register · probing ${toProbe.length} (${otherDomains.length} on other domains)`);

  let done = 0;
  const proposals = await pool(toProbe, 6, async (entry) => {
    const result = await probe(entry);
    done++;
    if (done % 10 === 0 || done === toProbe.length) console.log(`  ${done}/${toProbe.length} probed`);
    return result;
  });

  const found = proposals.filter((proposal) => proposal.listings.length);
  const taken = new Set(register.sites.map((site) => site.id));
  const added = found.map(({ entry, listings }) => ({
    id: siteId(entry, taken),
    name: entry.name,
    level: entry.scope === "IN" ? "central" : (UP_LEVELS[entry.category] ?? "directorate"),
    department: entry.name,
    listingUrls: listings.map((listing) => listing.url),
    docTypes: ["go", "circular"],
    language: "both",
    platform: "other",
    verified: true,
    priority: entry.scope === "IN" ? 4 : UP_LEVELS[entry.category] === "district" ? 5 : 3,
    approved: false,
    notes: `Found via IGOD (${entry.category}) on ${new Date().toISOString().slice(0, 10)}: ${listings.map((listing) => `${listing.label || "listing"} (${listing.documents} documents)`).join("; ")}.`,
    source: "igod",
  }));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report = [
    `# Site discovery (IGOD) — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    "",
    `${directory.length} sites in the directory; ${fresh.length} not in the register; ${toProbe.length} probed; ${found.length} have an order listing${dry ? " (dry run: register unchanged)" : " and were added with approved: false"}.`,
    "",
    "## With an order listing",
    "",
    "| Site | Level | Listing pages (documents) |",
    "|---|---|---|",
    ...added.map((site) => `| ${site.name} (${site.id}) | ${site.level} | ${site.listingUrls.map((url, index) => `${url} (${found[added.indexOf(site)].listings[index].documents})`).join("<br>")} |`),
    "",
    "## No listing found or not reachable",
    "",
    ...proposals.filter((proposal) => !proposal.listings.length).map(({ entry, problem }) => `- ${entry.name} — ${entry.url}${problem ? ` (${problem})` : ""}`),
    "",
    "## On other domains (add to the government host list if official)",
    "",
    ...otherDomains.map((entry) => `- ${entry.name} — ${entry.url}`),
    "",
  ].join("\n");
  const reportFile = path.join(outDir, `discover-${stamp}.md`);
  await writeFile(reportFile, report);

  if (!dry && added.length) {
    register.sites.push(...(added as unknown as Array<CrawlSite & { source?: string }>));
    const lines = ["{", `  "_about": ${JSON.stringify(register._about)},`, '  "sites": ['];
    lines.push(register.sites.map((site) => "    " + JSON.stringify(site)).join(",\n"));
    lines.push("  ]", "}");
    await writeFile(REGISTER_FILE, lines.join("\n") + "\n");
  }
  console.log(`\n${found.length} sites with an order listing${dry ? "" : " added to datasets/crawl/sites.json (approved: false)"}.`);
  console.log(`Report: ${path.relative(process.cwd(), reportFile)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
