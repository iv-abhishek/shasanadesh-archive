/**
 * "Which orders were issued …?" questions (ADR-057).
 *
 * Questions about recent or date-bound orders ("latest orders of basic
 * education", "orders issued this week", "21.09.2026 के शासनादेश", "August 2026
 * orders of PWD") are answered from the order list itself — dates, numbers and
 * subjects from the portal listing, newest first — not by semantic search,
 * which cannot rank by date. The answer is built without the model, so it is
 * instant and every line is a recorded fact.
 */

import type { Pool } from "pg";
import {
  departmentLabel,
  departmentPhrases,
  findDepartmentMention,
  normalizeName,
  type DepartmentEntry,
} from "../departments/registry.js";
import { browseDocuments, type BrowseRequest } from "../documents/browse.js";
import { normalizeDigits, parseReferenceDate } from "../relations/extract.js";

export interface ListingRequest {
  /** "recent": list by date only. "find": look for particular orders (ADR-058). */
  mode: "recent" | "find";
  /** The person clearly asked to find something (verb, GO number, quotes, wildcard). */
  explicit: boolean;
  department: DepartmentEntry | null;
  dateFrom?: string;
  dateTo?: string;
  /** Particular days ("10th or 15th September"); dateFrom/dateTo span them. */
  dates?: string[];
  /** How the range was asked for, e.g. "this week", "21 Sept 2026". */
  rangeLabel: { en: string; hi: string } | null;
  /** GO number prefix ("51/2026", "158/2026/।/1465529"). */
  goNumber?: string;
  /** Exact phrases the person put in quotes. */
  phrases: string[];
  /** Wildcard terms: `*` any run of characters, `?` one character. */
  patterns: string[];
  /** Issuing section (अनुभाग) or office named with "released/issued by". */
  section?: string;
  /** Other subject words, all required for a word match. */
  words: string[];
  /** Words for meaning-based subject matching (null when there are none). */
  semanticText: string | null;
  /** The words as one string, for messages. */
  topic: string | null;
}

// ---------------------------------------------------------------------------
// Dates (IST calendar days)
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const iso = (date: Date) => date.toISOString().slice(0, 10);
const fromIso = (value: string) => new Date(`${value}T00:00:00Z`);
const addDays = (value: string, days: number) => iso(new Date(fromIso(value).getTime() + days * DAY));

export function todayIn(zone = process.env.APP_TIME_ZONE || "Asia/Kolkata", now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const MONTH_WORDS: Array<[RegExp, number]> = [
  [/^(?:january|jan|जनवरी)$/, 1], [/^(?:february|feb|फरवरी|फ़रवरी)$/, 2], [/^(?:march|mar|मार्च)$/, 3],
  [/^(?:april|apr|अप्रैल|अप्रेल)$/, 4], [/^(?:may|मई)$/, 5], [/^(?:june|jun|जून)$/, 6],
  [/^(?:july|jul|जुलाई)$/, 7], [/^(?:august|aug|अगस्त)$/, 8], [/^(?:september|sept|sep|सितम्बर|सितंबर)$/, 9],
  [/^(?:october|oct|अक्टूबर|अक्तूबर)$/, 10], [/^(?:november|nov|नवम्बर|नवंबर)$/, 11], [/^(?:december|dec|दिसम्बर|दिसंबर)$/, 12],
];
const MONTH_ALT = "january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec|जनवरी|फरवरी|फ़रवरी|मार्च|अप्रैल|अप्रेल|मई|जून|जुलाई|अगस्त|सितम्बर|सितंबर|अक्टूबर|अक्तूबर|नवम्बर|नवंबर|दिसम्बर|दिसंबर";
const MONTH_ALT_RE = new RegExp(`^(?:${MONTH_ALT})$`);
const monthNumber = (word: string) => MONTH_WORDS.find(([pattern]) => pattern.test(word.toLowerCase()))?.[1] ?? null;
// Next to a day number a misspelt month is still a month ("Sepetember", "Agust"):
// within 1 edit of a short month name or 2 of a long one ("marks" is not March).
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}
function looseMonthNumber(word: string): number | null {
  const exact = monthNumber(word);
  if (exact) return exact;
  const lower = word.toLowerCase();
  if (!/^[a-z]{4,12}$/.test(lower)) return null;
  const index = MONTH_NAMES.findIndex((name) => editDistance(lower, name) <= (name.length <= 5 ? 1 : 2));
  return index >= 0 ? index + 1 : null;
}
const lastDayOf = (year: number, month: number) => iso(new Date(Date.UTC(year, month, 0)));
const pad = (n: number) => String(n).padStart(2, "0");
const dottedDate = (value: string) => `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}`;
const humanDate = (value: string) => {
  const date = fromIso(value);
  return `${date.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"][date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

// A single date written as numbers or words: 21/09/2026, 21.9.2026, 2026-09-21, 21 Sept 2026, 21 सितम्बर 2026.
const DATE_TEXT = `(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_ALT})\\.?,?\\s+\\d{4})`;

function parseOneDate(text: string): string | null {
  const iso8601 = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim());
  if (iso8601) return `${iso8601[1]}-${pad(Number(iso8601[2]))}-${pad(Number(iso8601[3]))}`;
  return parseReferenceDate(text.replace(/(\d)(st|nd|rd|th)\b/i, "$1").replace(/[.,]\s/g, " "));
}

interface Range {
  from?: string;
  to?: string;
  dates?: string[];
  label: { en: string; hi: string };
  matched: string;
}

function daysRange(dates: string[], matched: string): Range {
  if (dates.length === 1) {
    const [day] = dates;
    return { from: day, to: day, label: { en: `dated ${humanDate(day)}`, hi: `दिनांक ${dottedDate(day)}` }, matched };
  }
  return {
    from: dates[0],
    to: dates.at(-1),
    dates,
    label: {
      en: `dated ${dates.map(dottedDate).join(" or ")}`,
      hi: `दिनांक ${dates.map(dottedDate).join(" या ")}`,
    },
    matched,
  };
}

/** The first date range the question asks for, if any. `today` is YYYY-MM-DD. */
export function parseDateRange(rawQuery: string, today: string): Range | null {
  const query = normalizeDigits(rawQuery).toLowerCase();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const weekday = (fromIso(today).getUTCDay() + 6) % 7; // Monday = 0
  const tryMatch = (re: RegExp) => re.exec(query);
  let hit: RegExpExecArray | null;

  // between A and B / from A to B / A से B तक
  if ((hit = tryMatch(new RegExp(`(?:between|from)\\s+(${DATE_TEXT})\\s+(?:and|to|till|until)\\s+(${DATE_TEXT})`))) ||
      (hit = tryMatch(new RegExp(`(${DATE_TEXT})\\s+से\\s+(${DATE_TEXT})\\s+तक`)))) {
    const from = parseOneDate(hit[1]);
    const to = parseOneDate(hit[2]);
    if (from && to) {
      const [a, b] = from <= to ? [from, to] : [to, from];
      return { from: a, to: b, label: { en: `${humanDate(a)} – ${humanDate(b)}`, hi: `${dottedDate(a)} से ${dottedDate(b)} तक` }, matched: hit[0] };
    }
  }
  // since / after A, A के बाद / से
  if ((hit = tryMatch(new RegExp(`(?:since|after|from)\\s+(${DATE_TEXT})`))) ||
      (hit = tryMatch(new RegExp(`(${DATE_TEXT})\\s+(?:के\\s+बाद|से)`)))) {
    const from = parseOneDate(hit[1]);
    if (from) return { from, to: today, label: { en: `since ${humanDate(from)}`, hi: `${dottedDate(from)} से` }, matched: hit[0] };
  }
  // Several full dates: "10.09.2026 or 15.09.2026"
  {
    const all = [...query.matchAll(new RegExp(DATE_TEXT, "g"))];
    if (all.length >= 2) {
      const dates = [...new Set(all.map((m) => parseOneDate(m[0])).filter((d): d is string => Boolean(d)))].sort();
      if (dates.length >= 2) return daysRange(dates, query.slice(all[0].index, all.at(-1)!.index! + all.at(-1)![0].length));
    }
  }
  // Day(s) and a month, year optional: "10th or 15th September", "15 sept",
  // "10 और 15 सितम्बर 2026", "September 10, 15".
  {
    const ORD = "(?:st|nd|rd|th)?";
    const DAYS = `\\d{1,2}${ORD}(?:\\s*(?:,|or|and|&|और|या|व|तथा)\\s*\\d{1,2}${ORD})*`;
    const WORD = `(?:${MONTH_ALT}|[a-z]{3,12})`;
    const dayFirst = new RegExp(`(?:^|\\s)(${DAYS})\\s+(?:of\\s+)?(${WORD})\\.?(?:,?\\s+(\\d{4}))?(?=[\\s,.?!]|$)`);
    const monthFirst = new RegExp(`(?:^|\\s)(${WORD})\\.?\\s+(${DAYS})(?:,?\\s+(\\d{4}))?(?=[\\s,.?!]|$)`);
    for (const [re, dayGroup, monthGroup] of [[dayFirst, 1, 2], [monthFirst, 2, 1]] as const) {
      const found = re.exec(query);
      if (!found) continue;
      const month = looseMonthNumber(found[monthGroup]);
      if (!month) continue;
      const days = (found[dayGroup].match(/\d{1,2}/g) ?? []).map(Number).filter((d) => d >= 1 && d <= 31);
      if (!days.length) continue;
      const year = found[3] ? Number(found[3]) : null;
      const dates = days
        .map((day) => {
          // No year: the most recent such day that is not in the future.
          let y2 = year ?? Number(today.slice(0, 4));
          let value = `${y2}-${pad(month)}-${pad(day)}`;
          if (!year && value > today) value = `${--y2}-${pad(month)}-${pad(day)}`;
          return iso(fromIso(value)) === value ? value : null; // drops 31 Sept
        })
        .filter((d): d is string => Boolean(d));
      if (dates.length) return daysRange([...new Set(dates)].sort(), found[0].trim());
    }
  }
  // a single day
  if ((hit = tryMatch(new RegExp(DATE_TEXT)))) {
    const day = parseOneDate(hit[0]);
    if (day) return { from: day, to: day, label: { en: `dated ${humanDate(day)}`, hi: `दिनांक ${dottedDate(day)}` }, matched: hit[0] };
  }
  if ((hit = tryMatch(/\btoday\b|आज/))) return { from: today, to: today, label: { en: "today", hi: "आज" }, matched: hit[0] };
  if ((hit = tryMatch(/\byesterday\b|(?:^|\s)कल(?:\s|$)/))) {
    const day = addDays(today, -1);
    return { from: day, to: day, label: { en: "yesterday", hi: "कल" }, matched: hit[0] };
  }
  if ((hit = tryMatch(/\b(?:last|past)\s+(\d{1,3})\s+days?\b|पिछले\s+(\d{1,3})\s+दिन/))) {
    const days = Math.min(366, Number(hit[1] ?? hit[2]));
    return { from: addDays(today, -(days - 1)), to: today, label: { en: `in the last ${days} days`, hi: `पिछले ${days} दिनों में` }, matched: hit[0] };
  }
  if ((hit = tryMatch(/\bthis\s+week\b|इस\s+(?:सप्ताह|हफ्ते|हफ़्ते)/)))
    return { from: addDays(today, -weekday), to: today, label: { en: "this week", hi: "इस सप्ताह" }, matched: hit[0] };
  if ((hit = tryMatch(/\blast\s+week\b|पिछले\s+(?:सप्ताह|हफ्ते|हफ़्ते)/))) {
    const monday = addDays(today, -weekday - 7);
    return { from: monday, to: addDays(monday, 6), label: { en: "last week", hi: "पिछले सप्ताह" }, matched: hit[0] };
  }
  if ((hit = tryMatch(/\bthis\s+month\b|इस\s+(?:माह|महीने)/)))
    return { from: `${y}-${pad(m)}-01`, to: today, label: { en: "this month", hi: "इस माह" }, matched: hit[0] };
  if ((hit = tryMatch(/\blast\s+month\b|पिछले\s+(?:माह|महीने)/))) {
    const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
    return { from: `${py}-${pad(pm)}-01`, to: lastDayOf(py, pm), label: { en: "last month", hi: "पिछले माह" }, matched: hit[0] };
  }
  if ((hit = tryMatch(/\bthis\s+year\b|इस\s+(?:वर्ष|साल)/)))
    return { from: `${y}-01-01`, to: today, label: { en: "this year", hi: "इस वर्ष" }, matched: hit[0] };
  // a month, with or without a year ("August 2026", "सितम्बर")
  if ((hit = tryMatch(new RegExp(`(?:^|\\s)(${MONTH_ALT})\\.?(?:,?\\s+(\\d{4}))?(?=\\s|$)`)))) {
    const month = monthNumber(hit[1]);
    // "may" is also an English verb: only accept it with a year.
    if (month && !(hit[1] === "may" && !hit[2])) {
      const year = hit[2] ? Number(hit[2]) : month <= m ? y : y - 1;
      const to = lastDayOf(year, month);
      const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      return {
        from: `${year}-${pad(month)}-01`,
        to: to > today ? today : to,
        label: { en: `in ${names[month - 1]} ${year}`, hi: `${hit[1]} ${year} में` },
        matched: hit[0],
      };
    }
  }
  // a year on its own ("orders of 2025", "2025 के शासनादेश")
  if ((hit = tryMatch(/(?:^|\s)(?:in\s+)?((?:19|20)\d{2})(?:\s+(?:के|में))?(?=\s|$)/))) {
    const year = Number(hit[1]);
    if (year <= y) return { from: `${year}-01-01`, to: year === y ? today : `${year}-12-31`, label: { en: `in ${year}`, hi: `${year} में` }, matched: hit[0] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const ORDER_WORD = /\b(?:orders?|gos?|g\.o\.s?|government orders?|circulars?|notifications?|shasanadesh)\b|शासनादेश|आदेश|परिपत्र|अधिसूचना/;
const RECENT_WORD = /\b(?:recent|recently|latest|newest|new|fresh|last\s+\d+|released|issued|published|came out|list|dated)\b|हाल|हालिया|नवीनतम|नए|नये|नवीन|ताज़ा|ताजा|जारी|निर्गत|सूची|दिनांकित/;
// Questions about what an order says go to Ask, even if they mention "latest".
const CONTENT_QUESTION =
  /\b(?:what does|what do|says?|provisions?|rules? for|eligibility|procedure|process|how to|how do|how much|how many|explain|summar(?:y|ise|ize)|conditions?|limit|entitle|amount of|what (?:is|are) the (?!latest|recent|newest|new|last|orders?\b|gos?\b))\b|क्या\s+(?:प्रावधान|नियम|कहता|कहते|शर्त)|प्रावधान|प्रक्रिया|पात्रता|शर्तें|कैसे|कितना|कितनी|कितने|किस प्रकार/;

const FILLER = new Set([
  "recent", "recently", "latest", "newest", "new", "fresh", "released", "issued", "published", "came", "out", "list", "dated",
  "orders", "order", "gos", "go", "g", "o", "government", "govt", "circulars", "circular", "notifications", "notification", "shasanadesh",
  "department", "departments", "dept", "of", "in", "the", "by", "for", "from", "on", "and", "show", "me", "all", "any", "please", "give",
  "which", "what", "were", "was", "are", "is", "there", "have", "has", "been", "a", "an", "release", "to", "up", "uttar", "pradesh", "state",
  "or", "also", "our", "my", "tell", "about", "कृपया", "अथवा", "या", "तथा", "एवं", "और",
  "शासनादेश", "शासनादेशों", "आदेश", "आदेशों", "परिपत्र", "अधिसूचना", "विभाग", "विभागों", "हाल", "हालिया", "में", "के", "की", "का", "से", "द्वारा", "हेतु",
  "नवीनतम", "नए", "नये", "नवीन", "ताज़ा", "ताजा", "जारी", "निर्गत", "सूची", "किए", "किये", "गए", "गये", "हुए", "हैं", "है", "कौन", "कौनसे", "क्या", "बताइए",
  "बताएं", "बताओ", "दिखाइए", "दिखाएं", "सभी", "कोई", "उत्तर", "प्रदेश", "शासन", "दिनांकित", "तक", "बाद", "ही",
]);

const FIND_VERB =
  /^(?:please\s+|pls\s+|kindly\s+)?(?:find|search|look\s*up|lookup|locate|show|get|fetch|give)\b|\b(?:find|search\s+for|look\s+for|lookup|locate)\b|खोज|ढूंढ|ढूँढ|तलाश|दिखाइए|दिखाएं|दिखाओ/;
const ABOUT_CUE =
  /\b(?:about|regarding|related\s+to|relating\s+to|concerning|pertaining\s+to|on\s+the\s+subject\s+of|with\s+subject|subject)\b|के\s+(?:संबंध|सम्बन्ध|बारे|विषय)\s+में|विषयक|संबंधी|सम्बन्धी|से\s+(?:संबंधित|सम्बन्धित)/g;
// "released by <office>" / "<office> द्वारा जारी"
const RELEASED_BY_EN =
  /\b(?:released|issued|signed|sent)\s+by\s+(?:the\s+)?(.+?)(?=\s+(?:on|in|dated|between|since|from|during|about|regarding|for|with)\b|[,.?!]|\s*$)/;
const RELEASED_BY_HI = /(?:^|\s)((?:[\p{L}\p{M}0-9-]+\s+){1,5}?)द्वारा\s+(?:जारी|निर्गत)/u;
// A section named on its own: "कृषि अनुभाग-5", "लोक निर्माण अनुभाग 1"
const SECTION_MENTION = /(?:^|\s)((?:[\p{L}\p{M}]+\s+){1,4}अनुभाग(?:\s*[-–]?\s*\d+)?)(?=\s|$)/u;
const QUOTED = /["“”«»]([^"“”«»]{2,80})["“”«»]/g;
const FIND_FILLER = new Set([
  "find", "search", "look", "lookup", "locate", "get", "fetch", "want", "need", "i", "we", "you", "related", "regarding", "relating",
  "concerning", "pertaining", "subject", "with", "that", "this", "those", "these", "can", "could", "would", "should", "do", "does",
  "खोजें", "खोजिए", "खोजो", "ढूंढें", "ढूंढिए", "ढूँढें", "मुझे", "हमें", "चाहिए", "वाला", "वाले", "वाली", "संबंध", "सम्बन्ध", "बारे",
  "विषय", "विषयक", "संबंधी", "सम्बन्धी", "संबंधित", "सम्बन्धित", "लिए", "एक", "इस", "उस", "यह", "वह", "जो", "पर", "को", "ने",
  "संख्या", "सं0", "number", "no", "यो", "ऑर्डर",
]);
const isFiller = (word: string) => FILLER.has(word) || FIND_FILLER.has(word);

/**
 * Decide whether a question is about finding or listing orders, and pull out
 * its parts. Null means "a question about content: let Ask answer it".
 */
export function detectListingRequest(query: string, today = todayIn()): ListingRequest | null {
  const text = normalizeDigits(query).replace(/[\u200c\u200d]/g, "");
  const lower = text.toLowerCase();

  const phrases = [...lower.matchAll(QUOTED)].map((m) => m[1].trim()).filter((phrase) => phrase.length >= 2);
  let rest = ` ${lower.replace(QUOTED, " ").replace(/\s*\/\s*/g, "/")} `;

  // GO number: a serial, a slash and a year somewhere after it; not a date.
  let goNumber: string | undefined;
  for (const m of rest.matchAll(/(?<![\d/])(\d{1,5}\/[^\s,;]+)/g)) {
    const token = m[1].replace(/[.)\]:।]+$/, "");
    if (/^\d{1,2}[./-]\d{1,2}[./-]\d{4}$/.test(token)) continue;
    if (!/(?:19|20)\d{2}/.test(token.slice(token.indexOf("/") + 1))) continue;
    goNumber = token;
    rest = rest.replace(m[1], " ");
    break;
  }

  // Wildcard terms: "solar*", "*पंप*", "क?षि". A trailing "?" is punctuation.
  const patterns: string[] = [];
  rest = rest.replace(/\S*\*\S*|\S+\?\S+/g, (token) => {
    const pattern = token.replace(/^[(\["']+|[)\]"'.,;:!]+$/g, "");
    if (pattern.replace(/[*?]/g, "").length >= 2) patterns.push(pattern);
    return " ";
  });

  const hasOrderWord = ORDER_WORD.test(lower);
  const findVerb = FIND_VERB.test(lower.trim());
  const explicit = Boolean(goNumber || phrases.length || patterns.length || findVerb);
  if (CONTENT_QUESTION.test(lower) && !explicit) return null;
  if (!hasOrderWord && !explicit) return null;

  // Dates first, so neither the issuer ("released by X this week") nor a
  // subject word ("Sepetember") swallows them.
  const range = parseDateRange(query, today);
  if (range) {
    const matched = normalizeName(range.matched);
    rest = ` ${normalizeName(rest)} `.replace(` ${matched} `, " ").replace(matched, " ");
  }

  // Who issued it: a department, a section (अनुभाग), or both
  // ("released by कृषि अनुभाग-5" = Agriculture, section "कृषि अनुभाग-5").
  let section: string | undefined;
  let department: DepartmentEntry | null = null;
  const by = RELEASED_BY_EN.exec(rest) ?? RELEASED_BY_HI.exec(rest);
  if (by) {
    const who = by[1].trim();
    const named = findDepartmentMention(who);
    if (named) department = named.department;
    const englishNumber = /\bsection\s*[-–]?\s*(\d+)\b/.exec(who);
    if (englishNumber) section = `अनुभाग-${englishNumber[1]}`; // "Public Works section 1"
    else if (/अनुभाग/.test(who) || (!named && who.replace(/\s/g, "").length >= 3)) section = who;
    rest = rest.replace(by[0], " ");
  }
  const sectionMention = SECTION_MENTION.exec(rest);
  if (sectionMention) {
    section = sectionMention[1].trim();
    department ??= findDepartmentMention(section)?.department ?? null;
    rest = rest.replace(sectionMention[1], " ");
  }
  // English "section 1" means अनुभाग-1 (of the named department).
  const englishSection = /\bsection\s*[-–]?\s*(\d+)\b/.exec(rest);
  if (englishSection && !section) {
    section = `अनुभाग-${englishSection[1]}`;
    rest = rest.replace(englishSection[0], " ");
  }

  let mention = department ? null : findDepartmentMention(rest);
  if (mention?.strength === "weak") {
    // A one-word name ("home", "energy", "कारागार") is the department only
    // when nothing else is being searched for; otherwise it is a subject word
    // ("work from home", "solar energy subsidy").
    let without = ` ${normalizeName(rest)} `;
    for (const phrase of departmentPhrases(mention.department)) without = without.split(` ${phrase} `).join(" ");
    const others = without
      .replace(ABOUT_CUE, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 2 && !isFiller(word) && !/^\d+(?:st|nd|rd|th)?$/.test(word) && !MONTH_ALT_RE.test(word));
    if (others.length) mention = null;
  }
  department ??= mention?.department ?? null;
  if (department) {
    // Remove every way the question names this department ("Public Works
    // Department or PWD"), not just the one that matched; otherwise a second
    // name would be taken for a subject word.
    rest = ` ${normalizeName(rest)} `;
    for (const phrase of departmentPhrases(department).sort((x, y) => y.length - x.length)) {
      while (rest.includes(` ${phrase} `)) rest = rest.replace(` ${phrase} `, " ");
    }
  }


  rest = rest.replace(ABOUT_CUE, " ");
  const words = rest
    .replace(/[(),.?!।:;"'/-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2 && !isFiller(word) && !/^\d+(?:st|nd|rd|th)?$/.test(word))
    .slice(0, 8);

  const mode: ListingRequest["mode"] =
    words.length || goNumber || phrases.length || patterns.length || section ? "find" : "recent";
  // Naming the issuing office is a clear search, too.
  const explicitSearch = explicit || Boolean(by || section);
  if (mode === "recent" && !range && !RECENT_WORD.test(lower) && !department && !findVerb) return null;

  const semanticParts = [...phrases, ...words];
  return {
    mode,
    explicit: explicitSearch,
    department,
    dateFrom: range?.from,
    dateTo: range?.to,
    dates: range?.dates,
    rangeLabel: range?.label ?? null,
    goNumber,
    phrases,
    patterns,
    section,
    words,
    semanticText: semanticParts.length ? semanticParts.join(" ") : null,
    topic: words.length ? words.join(" ") : null,
  };
}

/** Same detection; the finder answers both "recent" and "find" questions. */
export const detectFindRequest = detectListingRequest;

// ---------------------------------------------------------------------------
// Answer
// ---------------------------------------------------------------------------

export interface ListedOrder {
  sourceId: string;
  department: string | null;
  goNumber: string | null;
  goDate: string | null;
  subject: string | null;
  sourceUrl: string;
  /** How it was found: its text contains the terms, or its subject is close in meaning. */
  match?: "words" | "similar";
  similarity?: number;
}

export interface ListingOutcome {
  orders: ListedOrder[];
  total: number;
  /** Where the orders were looked for: a named department, the profile, or everywhere. */
  scope: { kind: "department"; name: string } | { kind: "profile"; names: string[] } | { kind: "all" };
  /** The topic words were dropped because nothing matched them. */
  topicDropped: boolean;
  /** The profile had nothing, so every department was listed. */
  widened: boolean;
  /** Requested days (request.dates) on which no order was found. */
  emptyDates?: string[];
  /** Best subject similarity seen (for calibration), when meaning search ran. */
  bestSimilarity?: number;
  /** Meaning search was wanted but the retrieval service could not do it. */
  similarUnavailable?: boolean;
}

/** Cut at the last space before `max` characters and mark the cut. */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return `${text.slice(0, cut > max * 0.6 ? cut : max).trim()} …`;
}

const displayDate = (value: string | null) =>
  value ? `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}` : "—";

/** "GO number starting “51/2026”, “farmer registry”, solar*, section …" */
function describeCriteria(request: ListingRequest, hi: boolean): string {
  const parts: string[] = [];
  if (request.goNumber) parts.push(hi ? `संख्या “${request.goNumber}…”` : `GO number “${request.goNumber}…”`);
  for (const phrase of request.phrases) parts.push(`“${phrase}”`);
  for (const pattern of request.patterns) parts.push(`\`${pattern}\``);
  if (request.words.length) parts.push(`“${request.words.join(" ")}”`);
  if (request.section) parts.push(hi ? `अनुभाग “${request.section}”` : `section “${request.section}”`);
  return parts.join(hi ? ", " : ", ");
}

export function buildListingAnswer(request: ListingRequest, outcome: ListingOutcome, language: "hi" | "en"): string {
  const hi = language === "hi";
  const where =
    outcome.scope.kind === "department"
      ? outcome.scope.name
      : outcome.scope.kind === "profile"
        ? hi ? "आपके प्रोफ़ाइल के विभागों" : "your profile departments"
        : hi ? "सभी विभागों" : "all departments";
  const when = request.rangeLabel ? (hi ? request.rangeLabel.hi : request.rangeLabel.en) : null;
  const criteria = request.mode === "find" ? describeCriteria(request, hi) : "";

  if (!outcome.orders.length) {
    if (request.mode === "find") {
      return hi
        ? `संग्रह में ${criteria} से मेल खाता कोई शासनादेश नहीं मिला (${where}${when ? `, ${when}` : ""})। वर्तनी या शब्द बदलकर, * वाइल्डकार्ड के साथ, या शासनादेश पोर्टल (shasanadesh.up.gov.in) पर खोजें।`
        : `No order matching ${criteria} was found in the archive (${where}${when ? `, ${when}` : ""}). Try other words or spelling, a * wildcard, or the Shasanadesh portal (shasanadesh.up.gov.in).`;
    }
    return hi
      ? `संग्रह में ${where}${when ? ` के ${when}` : ""} कोई शासनादेश नहीं मिला। संग्रह अभी पूरा नहीं है; नवीनतम आदेश शासनादेश पोर्टल (shasanadesh.up.gov.in) पर पहले आते हैं।`
      : `No orders ${when ? `${when} ` : ""}were found for ${where} in the archive. The archive is not complete yet; the newest orders appear on the Shasanadesh portal (shasanadesh.up.gov.in) first.`;
  }

  const byWords = outcome.orders.filter((order) => order.match !== "similar");
  const similar = outcome.orders.filter((order) => order.match === "similar");

  let heading: string;
  if (request.mode === "recent") {
    heading = hi
      ? `**${where}** के ${when ? `${when} के ` : "नवीनतम "}शासनादेश (नए पहले; ${outcome.total} में से ${byWords.length}):`
      : `${when ? `Orders ${when}` : "Latest orders"} for **${where}**, newest first (${byWords.length} of ${outcome.total}):`;
  } else if (byWords.length) {
    heading = hi
      ? `${criteria} से मेल खाते शासनादेश — ${where}${when ? `, ${when}` : ""} (नए पहले; ${outcome.total} में से ${byWords.length}):`
      : `Orders matching ${criteria} — ${where}${when ? `, ${when}` : ""} (newest first; ${byWords.length} of ${outcome.total}):`;
  } else {
    heading = hi
      ? `${criteria} शब्दशः किसी शासनादेश में नहीं मिला। विषय के अर्थ में सबसे निकट शासनादेश — ${where}${when ? `, ${when}` : ""}:`
      : `No order contains ${criteria} word for word. Orders whose subject is closest in meaning — ${where}${when ? `, ${when}` : ""}:`;
  }

  const line = (order: ListedOrder, index: number, marker: string) => {
    const number = order.goNumber ? (hi ? `संख्या ${order.goNumber}` : `GO ${order.goNumber}`) : hi ? "संख्या अंकित नहीं" : "number not recorded";
    const subject =
      shorten((order.subject ?? "").replace(/\s+/g, " ").trim(), 220) ||
      (hi ? `विषय अंकित नहीं (आदेश ${order.sourceId})` : `subject not recorded (order ${order.sourceId})`);
    const department = outcome.scope.kind === "department" || !order.department ? "" : ` · ${order.department}`;
    return `${marker} **${displayDate(order.goDate)}** · ${number}${department} — ${subject} [S${index + 1} p.1]`;
  };
  const lines = byWords.map((order, index) => line(order, index, `${index + 1}.`));
  const similarLines = similar.map((order, index) => line(order, byWords.length + index, "-"));

  const body = [heading, ""];
  if (lines.length) body.push(...lines);
  if (similarLines.length) {
    if (lines.length) {
      body.push(
        "",
        hi ? "विषय के अर्थ में निकट अन्य शासनादेश (शब्दशः मेल नहीं):" : "Also close in meaning (subject does not contain the words):",
        "",
      );
    }
    body.push(...similarLines);
  }

  const notes: string[] = [];
  if (outcome.emptyDates?.length) {
    const days = outcome.emptyDates.map(displayDate).join(hi ? " या " : " or ");
    notes.push(hi ? `दिनांक ${days} का कोई शासनादेश संग्रह में नहीं मिला।` : `No orders dated ${days} were found in the archive.`);
  }
  if (outcome.widened) notes.push(hi ? "आपके प्रोफ़ाइल के विभागों में कोई आदेश नहीं मिला, इसलिए सभी विभाग दिखाए गए हैं।" : "Nothing matched in your profile departments, so all departments are shown.");
  if (outcome.topicDropped && request.topic)
    notes.push(hi ? `"${request.topic}" विषय वाला कोई आदेश नहीं मिला, इसलिए सभी आदेश दिखाए गए हैं।` : `No order's subject mentions "${request.topic}", so all orders are shown.`);
  if (request.mode === "find" && outcome.similarUnavailable && !similar.length)
    notes.push(hi ? "अर्थ-आधारित खोज अभी उपलब्ध नहीं है; केवल शब्दों से मिलान किया गया।" : "Meaning-based matching is not available right now; only word matches are shown.");
  notes.push(
    hi
      ? "यह सूची संग्रह में उपलब्ध आदेशों की है; नवीनतम आदेश पहले शासनादेश पोर्टल पर आते हैं। किसी आदेश की विषय-वस्तु जानने के लिए उसके बारे में पूछें।"
      : "This list covers the orders in the archive; the newest may reach the Shasanadesh portal first. Ask about any of them to see what it says.",
  );

  return [...body, "", ...notes].join("\n");
}

export type SubjectSearch = (
  query: string,
  options: { departmentIds?: number[]; dateFrom?: string; dateTo?: string; limit: number },
) => Promise<Array<{ sourceId: string; similarity: number }>>;

// Subject similarity (cosine, Qwen3 embeddings) below which a hit is not shown,
// and how far below the best hit one may be. Uncalibrated first values: the
// done event reports bestSimilarity so they can be tuned (ADR-058).
const MIN_SUBJECT_SIMILARITY = Number(process.env.FIND_MIN_SIMILARITY ?? 0.45);
const SUBJECT_SIMILARITY_SPREAD = 0.12;
const PAGE = 10;

/**
 * Find or list orders (ADR-057, ADR-058). Word matches come first, newest
 * first; when they are fewer than a page, orders whose subject is close in
 * meaning (any language) follow, most similar first. Returns null when the
 * question should go to normal Ask instead.
 */
export async function listOrders(
  pool: Pool,
  request: ListingRequest,
  profileDepartments: string[],
  language: "hi" | "en",
  subjectSearch?: SubjectSearch,
): Promise<{ text: string; outcome: ListingOutcome } | null> {
  const base: BrowseRequest = {
    dateFrom: request.dateFrom,
    dateTo: request.dateTo,
    goNumberPrefix: request.goNumber,
    sectionLike: request.section,
    phrases: request.phrases.length ? request.phrases : undefined,
    patterns: request.patterns.length ? request.patterns : undefined,
    pageSize: PAGE,
    sort: "date_desc",
  };

  // Finding a particular order searches every department unless one is named;
  // "recent orders" without a department means the person's own departments.
  let scope: ListingOutcome["scope"] = { kind: "all" };
  let filters: BrowseRequest = base;
  if (request.department) {
    scope = { kind: "department", name: departmentLabel(request.department, language) };
    filters = { ...base, departmentKeys: [`id:${request.department.id}`] };
  } else if (request.mode === "recent" && profileDepartments.length) {
    scope = { kind: "profile", names: profileDepartments };
    filters = { ...base, scopeDepartments: profileDepartments };
  }

  // Particular days ("10th or 15th September") are listed day by day, so a
  // busy day cannot crowd out the others; days with nothing are reported.
  let emptyDates: string[] = [];
  const browse = async (f: BrowseRequest) => {
    if (!request.dates?.length) return browseDocuments(pool, f);
    const perDay = await Promise.all(
      request.dates.map((day) => browseDocuments(pool, { ...f, dateFrom: day, dateTo: day })),
    );
    emptyDates = request.dates.filter((_, index) => perDay[index].total === 0);
    const rows = perDay
      .flatMap((day) => day.rows)
      .sort((a, b) => (b.goDate ?? "").localeCompare(a.goDate ?? ""))
      .slice(0, PAGE);
    return { total: perDay.reduce((sum, day) => sum + day.total, 0), page: 1, pageSize: PAGE, rows };
  };

  const text = request.words.join(" ") || undefined;
  let result = await browse({ ...filters, text });
  let widened = false;
  if (!result.total && scope.kind === "profile") {
    result = await browse({ ...base, text });
    scope = { kind: "all" };
    widened = result.total > 0;
  }

  const toOrder = (row: (typeof result.rows)[number], match: ListedOrder["match"], similarity?: number): ListedOrder => ({
    sourceId: row.sourceId,
    department: row.department,
    goNumber: row.goNumber,
    goDate: row.goDate,
    subject: row.subject,
    sourceUrl: row.sourceUrl,
    match,
    similarity,
  });
  const orders = result.rows.map((row) => toOrder(row, "words"));

  // Meaning-based subject matching fills the page (not for GO-number lookups).
  let bestSimilarity: number | undefined;
  let similarUnavailable = false;
  if (request.mode === "find" && request.semanticText && !request.goNumber && orders.length < PAGE) {
    if (!subjectSearch) {
      similarUnavailable = true;
    } else {
      const hits = await subjectSearch(request.semanticText, {
        departmentIds: request.department ? [request.department.id] : undefined,
        dateFrom: request.dateFrom,
        dateTo: request.dateTo,
        limit: 30,
      }).catch(() => null);
      if (!hits) {
        similarUnavailable = true;
      } else if (hits.length) {
        bestSimilarity = hits[0].similarity;
        const floor = Math.max(MIN_SUBJECT_SIMILARITY, bestSimilarity - SUBJECT_SIMILARITY_SPREAD);
        const seen = new Set(orders.map((order) => order.sourceId));
        const keep = hits.filter((hit) => hit.similarity >= floor && !seen.has(hit.sourceId));
        if (keep.length) {
          // Same filters as the word search (section, phrases, dates…), minus the words.
          const rows = await browseDocuments(pool, {
            ...filters,
            text: undefined,
            sourceIds: keep.map((hit) => hit.sourceId),
            pageSize: 100,
          });
          const byId = new Map(rows.rows.map((row) => [row.sourceId, row]));
          for (const hit of keep) {
            const row = byId.get(hit.sourceId);
            if (row && (!request.dates?.length || request.dates.includes(row.goDate ?? ""))) orders.push(toOrder(row, "similar", hit.similarity));
            if (orders.length >= PAGE) break;
          }
        }
      }
    }
  }

  // Nothing found for the subject words.
  let topicDropped = false;
  if (!orders.length && request.mode === "find") {
    if (request.department && request.words.length && !request.explicit && !request.goNumber) {
      // "<department> orders <words>": show the department's latest instead.
      const latest = await browse({ ...filters, text: undefined });
      orders.push(...latest.rows.map((row) => toOrder(row, "words")));
      result = latest;
      topicDropped = true;
    } else if (!request.explicit) {
      return null; // not clearly a search: let Ask answer from the text
    }
  }

  const outcome: ListingOutcome = {
    orders,
    total: result.total,
    scope,
    topicDropped,
    widened,
    emptyDates,
    bestSimilarity,
    similarUnavailable,
  };
  return { text: buildListingAnswer(request, outcome, language), outcome };
}
