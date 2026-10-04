/**
 * Pipeline stage: crawl — dry run for the owner's review (ADR-103)
 *
 * Purpose:
 *   Read the listing pages of register sites (approved or not) and report what
 *   the crawler would keep and drop, without downloading any document. The
 *   owner reads the report and sets "approved": true for the sites to crawl.
 *
 * Usage:
 *   npm run crawl:check -- uplc-gos awasbandhu-gos     (named sites)
 *   npm run crawl:check -- --priority 1                (all priority-1 sites)
 *   npm run crawl:check -- --all [--pages 3]
 *
 * Writes data/crawl/check-<timestamp>.md (readable) and .json (full entries).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { crawlSite, type SiteCrawl } from "../sources/crawl-sites.js";
import { loadRegister, type CrawlSite } from "./register.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function pick(args: string[], sites: CrawlSite[]): CrawlSite[] {
  const named = args.filter((arg, index) => !arg.startsWith("--") && !["--priority", "--pages"].includes(args[index - 1] ?? ""));
  if (named.length) {
    const unknown = named.filter((id) => !sites.some((site) => site.id === id));
    if (unknown.length) throw new Error("Unknown site id(s): " + unknown.join(", "));
    return sites.filter((site) => named.includes(site.id));
  }
  const priority = option(args, "--priority");
  if (priority) return sites.filter((site) => site.priority <= Number(priority));
  if (args.includes("--all")) return sites;
  throw new Error("Usage: npm run crawl:check -- <site id …> | --priority N | --all  [--pages N]");
}

function count<T>(values: T[]): Array<[T, number]> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

function summary(crawl: SiteCrawl): string[] {
  const { site, entries } = crawl;
  const kept = entries.filter((entry) => entry.admission.admitted);
  const dropped = entries.filter((entry) => !entry.admission.admitted);
  const dated = kept.filter((entry) => entry.item.date).map((entry) => entry.item.date!).sort();
  const lines = [
    `## ${site.id} — ${site.name}`,
    "",
    `- level ${site.level} · priority ${site.priority} · ${site.approved ? "**approved**" : "not approved"}${site.coveredBy ? ` · covered by adapter ${site.coveredBy}` : ""}`,
    `- listing pages read: ${crawl.pagesRead}${crawl.truncated ? " (stopped at the page limit; more exist)" : ""}`,
    `- documents found: ${entries.length} · **keep ${kept.length}** · drop ${dropped.length}${crawl.offHost.length ? ` · on other hosts ${crawl.offHost.length}` : ""}`,
    `- dates: ${dated.length ? `${dated[0]} to ${dated[dated.length - 1]} (${dated.length} dated)` : "none read"} · GO numbers read: ${kept.filter((entry) => entry.item.goNumber).length}`,
    `- kinds kept: ${count(kept.map((entry) => entry.admission.kind)).map(([kind, n]) => `${kind} ${n}`).join(", ") || "—"}`,
    `- dropped: ${count(dropped.map((entry) => entry.admission.reason)).map(([reason, n]) => `${reason} ${n}`).join(", ") || "—"}`,
  ];
  if (crawl.errors.length) lines.push(`- problems: ${crawl.errors.slice(0, 4).join(" · ")}`);
  const newest = [...kept].sort((a, b) => (b.item.date ?? "").localeCompare(a.item.date ?? "")).slice(0, 8);
  if (newest.length) {
    lines.push("", "| Date | GO number | Kind | Title |", "|---|---|---|---|");
    for (const { item, admission } of newest) {
      lines.push(`| ${item.date ?? ""} | ${(item.goNumber ?? "").replace(/\|/g, "/")} | ${admission.kind} | ${item.title.slice(0, 110).replace(/\|/g, "/")} |`);
    }
  }
  if (dropped.length) {
    lines.push("", "Dropped, for example:");
    for (const { item, admission } of dropped.slice(0, 4)) lines.push(`- (${admission.reason}) ${item.title.slice(0, 110)}`);
  }
  lines.push("");
  return lines;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { sites, problems } = loadRegister();
  const chosen = pick(args, sites);
  const pages = option(args, "--pages");
  const maxPages = pages ? Math.max(1, Number(pages)) : undefined;

  const crawls: SiteCrawl[] = [];
  for (const site of chosen) {
    process.stdout.write(`Reading ${site.id} … `);
    const crawl = await crawlSite(site, { maxPages });
    crawls.push(crawl);
    const kept = crawl.entries.filter((entry) => entry.admission.admitted).length;
    console.log(`${crawl.pagesRead} pages, ${crawl.entries.length} documents, keep ${kept}${crawl.errors.length ? `, ${crawl.errors.length} problem(s)` : ""}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve("data/crawl");
  await mkdir(dir, { recursive: true });
  const markdown = [
    `# Crawl check — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    "",
    "Nothing was downloaded. Set \"approved\": true in datasets/crawl/sites.json for the sites to crawl.",
    "",
    ...(problems.length ? ["Register entries not usable yet:", ...problems.map((problem) => `- ${problem.site}: ${problem.problem}`), ""] : []),
    ...crawls.flatMap(summary),
  ].join("\n");
  const base = path.join(dir, `check-${stamp}`);
  await writeFile(base + ".md", markdown);
  await writeFile(
    base + ".json",
    JSON.stringify(
      crawls.map((crawl) => ({ ...crawl, site: crawl.site.id })),
      null,
      2,
    ) + "\n",
  );
  console.log(`\nReport: ${path.relative(process.cwd(), base)}.md`);
  if (problems.length) console.log(`${problems.length} register entries need attention (listed in the report).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
