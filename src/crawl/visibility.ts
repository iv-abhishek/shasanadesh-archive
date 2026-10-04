/**
 * Pipeline stage: retrieval — who sees crawled district documents (ADR-097, ADR-103)
 *
 * Purpose:
 *   Headquarters officers should not get answers from a district's local
 *   notices and orders. Crawled sites at district or division level are
 *   searched only when the question names a UP district (or the caller asks
 *   for those collections explicitly).
 *
 * Invariants:
 *   - nothing is hidden while no district site is approved (empty list)
 *   - district names come from datasets/lgd/district-names-up.json (English,
 *     Hindi and former names)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { loadRegister, visibilityFor } from "./register.js";

let providersCache: string[] | null = null;
let namesCache: string[] | null = null;

export function districtProviders(): string[] {
  if (providersCache) return providersCache;
  try {
    providersCache = loadRegister()
      .sites.filter((site) => site.approved && !site.coveredBy && visibilityFor(site.level) === "district")
      .map((site) => `crawl-${site.id}`);
  } catch {
    providersCache = [];
  }
  return providersCache;
}

function districtNames(): string[] {
  if (namesCache) return namesCache;
  try {
    const file = path.resolve("datasets/lgd/district-names-up.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as { districts: Record<string, { en?: string; hi?: string; aliases?: string[] }> };
    namesCache = Object.values(data.districts)
      .flatMap((district) => [district.en, district.hi, ...(district.aliases ?? [])])
      .filter((name): name is string => Boolean(name && name.trim().length >= 3))
      .map((name) => name.toLowerCase());
  } catch {
    namesCache = [];
  }
  return namesCache;
}

export function namesDistrict(text: string): boolean {
  const value = text.toLowerCase();
  return districtNames().some((name) => {
    if (/[ऀ-ॿ]/.test(name)) return value.includes(name);
    return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(value);
  });
}

/** Providers to leave out of a search, or undefined when nothing needs hiding. */
export function hiddenProviders(question: string, explicitProviders?: string[]): string[] | undefined {
  const district = districtProviders();
  if (!district.length || explicitProviders?.length || namesDistrict(question)) return undefined;
  return district;
}
