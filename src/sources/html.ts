/**
 * Small HTML helpers shared by listing-page adapters. Government listing pages
 * are simple server-rendered tables, so regular expressions are enough and
 * avoid a DOM dependency; each adapter has a fixture test that pins the markup
 * it expects.
 */

export function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function textContent(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? decodeEntities(match[2]) : null;
}

/** Every <a> in a fragment, with its href resolved against baseUrl. */
export function anchors(html: string, baseUrl: string): Array<{ href: string; label: string }> {
  const links: Array<{ href: string; label: string }> = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attribute(match[1], "href");
    if (!href || /^(javascript:|mailto:|#)/i.test(href)) continue;
    try {
      links.push({ href: new URL(href.trim(), baseUrl).href, label: textContent(match[2]) });
    } catch {
      // Ignore malformed links in public-site markup.
    }
  }
  return links;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "September 11, 2026" → "2026-09-11"; impossible years (e.g. "-0001") → null. */
export function parseEnglishLongDate(value: string): string | null {
  const match = value.match(/\b([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\b/);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  const year = Number(match[3]);
  if (month < 0 || year < 1947) return null;
  return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

/** "30-08-2019" / "30.08.2019" / "30/08/2019" (day first) → "2019-08-30". */
export function parseDayFirstDate(value: string): string | null {
  const match = value.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (!match) return null;
  const [, day, month, year] = match;
  if (Number(month) > 12 || Number(day) > 31) return null;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function guessLanguage(title: string): "hi" | "en" | "mixed" | "unknown" {
  const hasDevanagari = /[ऀ-ॿ]/.test(title);
  const hasLatin = /[A-Za-z]{3,}/.test(title);
  if (hasDevanagari && hasLatin) return "mixed";
  if (hasDevanagari) return "hi";
  if (hasLatin) return "en";
  return "unknown";
}
