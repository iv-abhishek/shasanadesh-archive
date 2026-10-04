/**
 * Live search of official government websites (ADR-096), the third layer
 * after the archive (Shasanadesh orders and rulebooks) and before a general-
 * knowledge answer.
 *
 * One fixed search call per question, made by our code (no model deciding to
 * search again and again): Uttar Pradesh government sites first; central
 * government sites only when the state sites have nothing. Other states'
 * sites are dropped (a Karnataka leave page is not a UP rule). Results become
 * evidence pages labelled "Official website", cited like any page, and every
 * link found is written to data/web-found/links.jsonl for the crawler to
 * review (the archive learns from the questions).
 *
 * Provider: Tavily (TAVILY_API_KEY). A daily credit cap keeps the free plan
 * (1,000 credits a month) from running out.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { isGovernmentUrl } from "../lib/government-hosts.js";
import type { RetrievalEvidence } from "./types.js";

export const WEB_SEARCH_ENABLED = process.env.RAG_WEB_SEARCH !== "0" && Boolean(process.env.TAVILY_API_KEY);
const DAILY_CREDITS = Math.max(0, Number.parseInt(process.env.RAG_WEB_SEARCH_DAILY_CREDITS ?? "30", 10) || 0);
const TIMEOUT_MS = Math.max(2000, Number.parseInt(process.env.RAG_WEB_SEARCH_TIMEOUT_MS ?? "25000", 10) || 25000);
const MIN_SCORE = Number.parseFloat(process.env.RAG_WEB_SEARCH_MIN_SCORE ?? "0.3") || 0.3;
const FOUND_LOG = path.resolve(process.env.WEB_FOUND_LOG ?? "data/web-found/links.jsonl");
const MAX_PAGE_CHARS = 6000;

export const UP_DOMAINS = ["up.gov.in", "up.nic.in"];
export const CENTRAL_DOMAINS = ["gov.in", "nic.in"];
/** Individual bids and contract files: noise for rule questions. */
const EXCLUDED_DOMAINS = ["bidplus.gem.gov.in", "fulfilment.gem.gov.in", "mkp.gem.gov.in"];

// Other states' sites ("dpar.karnataka.gov.in", "csharyana.gov.in").
const OTHER_STATES = [
  "andhra", "arunachal", "assam", "bihar", "chhattisgarh", "cgstate", "goa", "gujarat", "haryana",
  "himachal", "hp.gov", "jharkhand", "karnataka", "kerala", "madhya", "mp.gov", "mpgov", "maharashtra",
  "manipur", "meghalaya", "mizoram", "nagaland", "odisha", "orissa", "punjab", "rajasthan", "sikkim",
  "tamil", "tn.gov", "telangana", "tripura", "uttarakhand", "uk.gov", "westbengal", "wb.gov", "delhi",
  "jammu", "jk.gov", "ladakh", "puducherry", "chandigarh",
];

export function isOtherStateHost(host: string): boolean {
  const h = host.toLowerCase();
  return OTHER_STATES.some((name) => h.includes(name));
}

export function isUpHost(host: string): boolean {
  const h = host.toLowerCase();
  return UP_DOMAINS.some((domain) => h === domain || h.endsWith(`.${domain}`)) || /(^|\.)up[a-z]*\.(gov|nic)\.in$/.test(h);
}

let creditDay = "";
let creditsUsed = 0;

function spend(credits: number): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== creditDay) {
    creditDay = today;
    creditsUsed = 0;
  }
  if (creditsUsed + credits > DAILY_CREDITS) return false;
  creditsUsed += credits;
  return true;
}

export interface WebResult {
  url: string;
  title: string;
  text: string;
  score: number;
  up: boolean;
}

interface TavilyResult {
  url?: string;
  title?: string;
  content?: string;
  raw_content?: string | null;
  score?: number;
}

async function tavily(query: string, includeDomains: string[], signal?: AbortSignal): Promise<TavilyResult[]> {
  // "advanced" depth costs 2 credits; "basic" found nothing for most rule questions (4 Oct test).
  if (!spend(2)) throw new Error("daily web-search credit limit reached");
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({
      query: query.slice(0, 380),
      search_depth: "advanced",
      max_results: 5,
      include_domains: includeDomains,
      exclude_domains: EXCLUDED_DOMAINS,
      include_raw_content: "text",
      include_answer: false,
    }),
  });
  if (!response.ok) throw new Error(`web search returned ${response.status}`);
  return ((await response.json()) as { results?: TavilyResult[] }).results ?? [];
}

/** Keep official, non-other-state results above the score floor. */
export function acceptResults(results: TavilyResult[], minScore = MIN_SCORE): WebResult[] {
  const seen = new Set<string>();
  return results.flatMap((item) => {
    if (!item.url || !isGovernmentUrl(item.url) || seen.has(item.url)) return [];
    const host = new URL(item.url).hostname;
    if (isOtherStateHost(host) || (item.score ?? 0) < minScore) return [];
    seen.add(item.url);
    const text = (item.raw_content || item.content || "").replace(/\s+/g, " ").trim();
    if (text.length < 200) return [];
    return [{ url: item.url, title: (item.title || host).trim(), text: text.slice(0, MAX_PAGE_CHARS), score: item.score ?? 0, up: isUpHost(host) }];
  });
}

/**
 * UP sites first; central sites only when the state sites gave nothing
 * usable. At most two searches (4 credits) per question.
 */
export async function searchOfficialWeb(query: string, signal?: AbortSignal): Promise<WebResult[]> {
  if (!WEB_SEARCH_ENABLED) return [];
  // A slow or failed state search still lets the central search run.
  const state = await tavily(`Uttar Pradesh ${query}`, UP_DOMAINS, signal)
    .then((results) => acceptResults(results))
    .catch((error) => {
      if (signal?.aborted) throw error;
      return [] as WebResult[];
    });
  if (state.length) return state;
  return acceptResults(await tavily(query, CENTRAL_DOMAINS, signal));
}

/** Evidence pages for the generator, numbered after `startAt`. */
export function webEvidence(results: WebResult[], startAt = 0): RetrievalEvidence[] {
  return results.map((result, index) => {
    const id = createHash("sha1").update(result.url).digest("hex").slice(0, 12);
    return {
      label: `S${startAt + index + 1}`,
      source_id: `web-${id}`,
      document_title: `${result.title} — ${result.up ? "Uttar Pradesh government website" : "Government of India website"}`,
      page_number: 1,
      department: new URL(result.url).hostname,
      go_number: null,
      go_date: null,
      source_url: result.url,
      page_url: result.url,
      jurisdiction_code: result.up ? "UP" : "IN",
      provider: "web-official",
      tier: null,
      doc_type: null,
      retrieval_role: "direct",
      anchor_page_number: null,
      selected_variant: "native",
      selected_canonical: true,
      numeric_conflict: false,
      numeric_verification_status: "native_primary",
      rerank_score_raw: result.score,
      fused_score: result.score,
      matched_chunk_text: result.text.slice(0, 1200),
      selected_page_text: result.text,
      canonical_page_text: result.text,
    };
  });
}

export const WEB_EVIDENCE_PROMPT = [
  "OFFICIAL WEBSITE RESULTS: no archived order or rulebook page answered this, so the pages below come from a live search of government websites. They are official but not checked by us.",
  "- Start the answer with one short line saying it is based on official government websites, not on the archived orders.",
  "- For each point, say whose rule it is: Uttar Pradesh government, or Government of India (a central rule applies to UP staff only if a UP order adopts it — say so when the page is central).",
  "- Cite each point to its page as usual; if the pages do not answer the question, reply NO_ANSWER.",
].join("\n");

/** Record links found, for the crawler to review and add to the archive. */
export async function logFoundLinks(query: string, results: WebResult[], usedInAnswer: boolean): Promise<void> {
  if (!results.length) return;
  await mkdir(path.dirname(FOUND_LOG), { recursive: true });
  const at = new Date().toISOString();
  await appendFile(
    FOUND_LOG,
    results
      .map((result) => JSON.stringify({ at, query, url: result.url, title: result.title, up: result.up, score: result.score, usedInAnswer }))
      .join("\n") + "\n",
  );
}
