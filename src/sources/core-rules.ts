/**
 * Pipeline stage: source discovery — curated core rules (ADR-062)
 *
 * Purpose:
 *   The rulebooks, manuals and standing orders officials cite daily (GFR,
 *   DFPR, procurement manuals, GeM terms and UP GeM orders, UP Budget Manual,
 *   conduct rules …). They live on many official sites, so instead of crawling
 *   we keep a reviewed catalogue: datasets/core-rules/catalogue.json. Discovery
 *   only reads it; ingest-source.ts downloads, hashes, archives (B2
 *   archive/core-rules/…) and extracts as for any adapter.
 *
 * Invariants:
 *   - only catalogue URLs are fetched (HTTPS, hosts derived from the catalogue)
 *   - sourceId = "core-rules-<slug>", stable across runs
 *   - the whole catalogue entry is kept in sourceRecord (edition, provenance
 *     note, preferred Shasanadesh copy, what it amends)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { SourceAdapter, SourceDocument, SourceLanguage } from "./types.js";
import { isGovernmentHost } from "../lib/government-hosts.js";

export interface CoreRuleEntry {
  slug: string;
  title: string;
  titleHi?: string | null;
  issuer: string;
  jurisdiction: "central" | "state";
  department: string | null;
  documentType: string;
  topics: string[];
  edition: string | null;
  date: string | null;
  goNumber: string | null;
  language: SourceLanguage;
  officialPage: string;
  downloadUrl: string;
  sourceNote: string;
  preferredSource?: { provider: string; goNumber: string; date: string } | null;
  amends?: string[];
}

const CATALOGUE = path.resolve("datasets/core-rules/catalogue.json");

/** Throws on anything that must not be ingested (so a bad entry fails loudly). */
export function validateCatalogue(entries: CoreRuleEntry[]): void {
  const slugs = new Set<string>();
  for (const entry of entries) {
    const where = `core-rules entry "${entry.slug}"`;
    if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(entry.slug)) throw new Error(`${where}: slug must be lowercase letters, digits and dashes`);
    if (slugs.has(entry.slug)) throw new Error(`${where}: duplicate slug`);
    slugs.add(entry.slug);
    for (const key of ["downloadUrl", "officialPage"] as const) {
      const url = new URL(entry[key]);
      if (url.protocol !== "https:") throw new Error(`${where}: ${key} must be HTTPS`);
      if (!isGovernmentHost(url.hostname)) throw new Error(`${where}: ${key} must be on a government host (.gov.in / .nic.in, docs/RULES.md §2)`);
    }
    if (entry.date && !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) throw new Error(`${where}: date must be YYYY-MM-DD`);
    if (!["central", "state"].includes(entry.jurisdiction)) throw new Error(`${where}: jurisdiction must be central or state`);
    for (const target of entry.amends ?? []) {
      if (!entries.some((other) => other.slug === target)) throw new Error(`${where}: amends unknown entry "${target}"`);
    }
  }
}

export function loadCatalogue(file = CATALOGUE): CoreRuleEntry[] {
  const entries = (JSON.parse(readFileSync(file, "utf8")) as { entries: CoreRuleEntry[] }).entries;
  validateCatalogue(entries);
  return entries;
}

export function toSourceDocument(entry: CoreRuleEntry): SourceDocument {
  return {
    sourceId: `core-rules-${entry.slug}`,
    title: entry.title,
    sourceUrl: entry.officialPage,
    downloadUrl: entry.downloadUrl,
    listingUrls: [entry.officialPage],
    issuer: entry.issuer,
    jurisdiction: entry.jurisdiction,
    department: entry.department,
    documentType: entry.documentType,
    goDate: entry.date,
    goNumber: entry.goNumber,
    language: entry.language,
    titles: {
      hi: entry.titleHi ?? (entry.language === "hi" ? entry.title : null),
      en: entry.language === "hi" ? null : entry.title,
    },
    sourceRecord: { ...entry, collection: "core-rules" },
  };
}

function catalogueHosts(): string[] {
  try {
    return [...new Set(loadCatalogue().flatMap((entry) => [new URL(entry.downloadUrl).hostname, new URL(entry.officialPage).hostname]))];
  } catch {
    return [];
  }
}

export const coreRulesAdapter: SourceAdapter = {
  id: "core-rules",
  collection: "core-rules",
  displayName: "Core rules and guidelines (curated)",
  allowedHosts: catalogueHosts(),
  async discover() {
    return loadCatalogue().map(toSourceDocument);
  },
};
