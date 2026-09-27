/**
 * Pipeline stage: provenance audit (npm run sources:audit) — Rulebook §2
 *
 * Purpose:
 *   Check every archived document's URLs (source, download, listing pages)
 *   against the government-host policy (src/lib/government-hosts.ts). A
 *   document with any non-government URL is flagged in its metadata.json
 *   (provenance.government = false); db:load then sets provenance_ok = false
 *   and it is kept out of answers and order search until reviewed.
 *
 * Invariants:
 *   - nothing is deleted; flags are reversible (fix the source, re-run)
 *   - metadata is rewritten only when the verdict changes
 *   - exit code 1 when anything is flagged, so the daily sync reports it
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isGovernmentHost } from "./lib/government-hosts.js";

const documentsRoot = path.resolve("data/documents");

export function provenanceOf(metadata: Record<string, unknown>): { government: boolean; hosts: string[]; privateHosts: string[] } {
  const urls: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) urls.push(value);
    if (Array.isArray(value)) value.forEach(add);
  };
  add(metadata.sourceUrl);
  add(metadata.downloadUrl);
  add(metadata.listingUrls);
  add((metadata.sourceRecord as Record<string, unknown> | undefined)?.downloadUrl);
  add((metadata.sourceRecord as Record<string, unknown> | undefined)?.officialPage);
  const hosts = [...new Set(urls.map((url) => new URL(url).hostname.toLowerCase()))].sort();
  const privateHosts = hosts.filter((host) => !isGovernmentHost(host));
  // No URL at all is also not a verified government source.
  return { government: hosts.length > 0 && privateHosts.length === 0, hosts, privateHosts };
}

async function main() {
  let checked = 0;
  const flagged: Array<{ sourceId: string; privateHosts: string[] }> = [];
  for (const entry of await readdir(documentsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const file = path.join(documentsRoot, entry.name, "metadata.json");
    const metadata = await readFile(file, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => null);
    if (!metadata?.sourceId) continue;
    checked++;
    const verdict = provenanceOf(metadata);
    const previous = metadata.provenance as { government?: boolean; privateHosts?: string[] } | undefined;
    if (!verdict.government) flagged.push({ sourceId: String(metadata.sourceId), privateHosts: verdict.privateHosts });
    if (previous?.government !== verdict.government || JSON.stringify(previous?.privateHosts ?? []) !== JSON.stringify(verdict.privateHosts)) {
      metadata.provenance = {
        ...verdict,
        checkedAt: new Date().toISOString(),
        ...(verdict.government ? {} : { flag: "non-government source (docs/RULES.md §2): excluded from answers until reviewed" }),
      };
      await writeFile(file, JSON.stringify(metadata, null, 2) + "\n", "utf8");
    }
  }
  console.log("Source provenance audit (government sources only)");
  console.log("=================================================");
  console.log(`Documents checked: ${checked}`);
  console.log(`Flagged:           ${flagged.length}`);
  for (const item of flagged.slice(0, 50)) console.log(`  ${item.sourceId}  ${item.privateHosts.join(", ") || "(no source URL)"}`);
  if (flagged.length) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("audit-provenance.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
