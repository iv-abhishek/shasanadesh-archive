/**
 * Pipeline stage: source discovery / capture
 *
 * Purpose:
 *   One polite HTTP client for every government site the archive reads:
 *   honest User-Agent, timeouts, an HTTPS host allowlist that is re-checked
 *   after redirects, robots.txt compliance, and a per-host minimum gap between
 *   requests.
 *
 * Invariants:
 *   - never follow a redirect off the adapter's allowlisted hosts
 *   - never request a path that the host's robots.txt disallows for us
 *   - never go below CRAWL_DELAY_MS (minimum 3 s) between requests to one host
 *
 * See docs/CONFIGURATION.md (crawl settings) and docs/DECISIONS.md (ADR-044).
 */

import { crawlDelayMs, crawlerUserAgent } from "../lib/tool-config.js";

export class PolicyError extends Error {}

const lastRequestAt = new Map<string, number>();
const robotsCache = new Map<string, RobotsRules>();

interface RobotsRules {
  disallow: string[];
  allow: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until the per-host gap has passed, then record this request. */
async function pace(host: string): Promise<void> {
  const gap = crawlDelayMs();
  const previous = lastRequestAt.get(host);
  if (previous !== undefined) {
    const wait = previous + gap - Date.now();
    if (wait > 0) await sleep(wait);
  }
  lastRequestAt.set(host, Date.now());
}

/**
 * Minimal robots.txt reader: groups for "*" or our product token, longest
 * matching rule wins (as in RFC 9309). A missing or non-text robots.txt (these
 * ASP.NET sites answer 404 with an HTML page) means no restrictions.
 */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const token = userAgent.split("/")[0].trim().toLowerCase();
  const rules: RobotsRules = { disallow: [], allow: [] };
  let groupApplies = false;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      const agent = value.toLowerCase();
      const matches = agent === "*" || (token.length > 0 && agent.includes(token));
      groupApplies = lastWasAgent ? groupApplies || matches : matches;
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!groupApplies || !value) continue;
    if (field === "disallow") rules.disallow.push(value);
    if (field === "allow") rules.allow.push(value);
  }
  return rules;
}

export function robotsAllows(rules: RobotsRules, pathAndQuery: string): boolean {
  const longest = (list: string[]) =>
    Math.max(-1, ...list.filter((rule) => pathAndQuery.startsWith(rule.replace(/\*.*$/, ""))).map((rule) => rule.length));
  const disallowed = longest(rules.disallow);
  if (disallowed < 0) return true;
  return longest(rules.allow) >= disallowed;
}

async function robotsFor(origin: string): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;

  let rules: RobotsRules = { disallow: [], allow: [] };
  try {
    await pace(new URL(origin).host);
    const response = await fetch(origin + "/robots.txt", {
      headers: { "User-Agent": crawlerUserAgent() },
      signal: AbortSignal.timeout(20_000),
    });
    const type = response.headers.get("content-type") ?? "";
    if (response.ok && type.includes("text/plain")) {
      rules = parseRobots(await response.text(), crawlerUserAgent());
    }
  } catch {
    // Unreachable robots.txt is treated as "no rules"; the request itself
    // will fail the same way if the host is down.
  }
  robotsCache.set(origin, rules);
  return rules;
}

export interface PoliteFetchOptions {
  allowedHosts: readonly string[];
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  accept?: string;
  timeoutMs?: number;
  userAgent?: string;
}

export function assertAllowedUrl(value: string, allowedHosts: readonly string[]): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname)) {
    throw new PolicyError(`Refusing ${url.href}: not an HTTPS URL on ${allowedHosts.join(", ")}`);
  }
  return url;
}

/** Fetch one official URL under the archive's crawl policy. */
export async function politeFetch(value: string, options: PoliteFetchOptions): Promise<Response> {
  const url = assertAllowedUrl(value, options.allowedHosts);
  const rules = await robotsFor(url.origin);
  if (!robotsAllows(rules, url.pathname + url.search)) {
    throw new PolicyError(`robots.txt on ${url.host} disallows ${url.pathname}`);
  }

  await pace(url.host);
  const response = await fetch(url.href, {
    method: options.method ?? "GET",
    body: options.body,
    redirect: "follow",
    headers: {
      "User-Agent": crawlerUserAgent(options.userAgent),
      Accept: options.accept ?? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      "Accept-Language": "hi-IN,hi;q=0.9,en-IN;q=0.8,en;q=0.7",
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });

  // Redirects are followed by fetch; re-check where we ended up.
  assertAllowedUrl(response.url || url.href, options.allowedHosts);
  return response;
}
