/**
 * Rulebooks an officer names in the question ("as per GeM GTC", "GFR mein",
 * "works manual"). When the search did not bring any page of the named
 * rulebook, a second, narrow search inside it adds its best pages, so the
 * answer can cite the book the officer asked about (ADR-091).
 */
import type { RetrievalEvidence, RetrievalResponse } from "./types.js";

export interface NamedSource {
  name: string;
  sourceIds: string[];
}

const NAMED: Array<NamedSource & { pattern: RegExp; unless?: RegExp }> = [
  {
    name: "UP GeM orders",
    pattern: /\b(up|u\.p\.|uttar pradesh)\s+gem\s+(go|gos|order|orders|shasanadesh)\b|\bgem\s+(go|gos|shasanadesh)\b|जेम.{0,25}शासनादेश/iu,
    sourceIds: [
      "core-rules-up-gem-go-2024-11-26",
      "core-rules-up-gem-go-2025-03-11",
      "core-rules-up-gem-go-2025-07-21",
      "core-rules-up-mse-startup-performance-security-relaxation-2021",
    ],
  },
  {
    name: "GeM GTC",
    pattern: /\bgtc\b|general terms (and|&) conditions (on|of|for) gem|जी\.?\s?टी\.?\s?सी|जीटीसी/iu,
    sourceIds: ["core-rules-gem-gtc-4-0"],
  },
  {
    name: "GFR 2017",
    pattern: /\bgfrs?\b|\bgrf\b|general financial rules?|जी\.?\s?एफ\.?\s?आर|जीएफआर|सामान्य वित्तीय नियम/iu,
    sourceIds: [
      "core-rules-gfr-2017",
      "core-rules-gfr-rule-151-amendment-2026",
      "core-rules-gfr-144xi-amendment-2023",
      "core-rules-gfr-144xi-land-border-2020",
    ],
  },
  {
    name: "DFPR",
    pattern: /\bdfpr\b|delegation of financial powers rules?/iu,
    sourceIds: ["core-rules-dfpr-2024"],
  },
  {
    name: "Manual for Procurement of Works",
    pattern: /\bworks?\s+manual\b|\bmanual\s+(for|of)\s+(the\s+)?(procurement\s+of\s+)?works?\b|\bprocurement\s+of\s+works\b/iu,
    sourceIds: ["core-rules-manual-works-2025"],
  },
  {
    name: "Manual for Procurement of Non-Consultancy Services",
    pattern: /non[\s-]?consultancy/iu,
    sourceIds: ["core-rules-manual-non-consultancy-2025"],
  },
  {
    name: "Manual for Procurement of Consultancy Services",
    pattern: /\bconsultancy\s+(services\s+)?manual\b|\bmanual\s+(for|of)\s+(procurement\s+of\s+)?consultancy\b/iu,
    unless: /non[\s-]?consultancy/iu,
    sourceIds: ["core-rules-manual-consultancy-2025"],
  },
  {
    name: "UP Procurement Manual (Goods) 2016",
    pattern: /\b(up|u\.p\.|uttar pradesh)\s+procurement\s+manual\b|procurement\s+manual.{0,30}\b2016\b|उत्तर प्रदेश प्रोक्योरमेंट मैनुअल|प्रोक्योरमेंट मैनुअल/iu,
    sourceIds: ["core-rules-up-procurement-manual-goods-2016"],
  },
  {
    name: "Manual for Procurement of Goods",
    pattern: /\bgoods\s+manual\b|\bmanual\s+(for|of)\s+(the\s+)?(procurement\s+of\s+)?goods\b/iu,
    unless: /\b(up|u\.p\.|uttar pradesh)\s+procurement\s+manual\b|\b2016\b/iu,
    sourceIds: ["core-rules-manual-goods-2024"],
  },
];

/** The rulebooks named in a question, most specific first. */
export function namedSources(question: string): NamedSource[] {
  return NAMED.filter((entry) => entry.pattern.test(question) && !(entry.unless?.test(question) ?? false)).map(
    ({ name, sourceIds }) => ({ name, sourceIds }),
  );
}

/** Named rulebooks that have no page among the evidence. */
export function missingNamedSources(named: NamedSource[], evidence: RetrievalEvidence[]): NamedSource[] {
  const present = new Set(evidence.map((item) => item.source_id));
  return named.filter((source) => !source.sourceIds.some((id) => present.has(id)));
}

/**
 * Put the named rulebook's pages first and renumber S1..Sn, dropping the
 * weakest pages so the evidence does not grow past `limit`.
 */
export function mergeNamedPages(
  retrieval: RetrievalResponse,
  extra: RetrievalEvidence[],
  limit: number,
): RetrievalResponse {
  const seen = new Set(extra.map((item) => `${item.source_id}#${item.page_number}`));
  const rest = retrieval.evidence.filter((item) => !seen.has(`${item.source_id}#${item.page_number}`));
  const evidence = [...extra, ...rest].slice(0, Math.max(limit, extra.length)).map((item, index) => ({
    ...item,
    label: `S${index + 1}`,
  }));
  return { ...retrieval, evidence };
}
