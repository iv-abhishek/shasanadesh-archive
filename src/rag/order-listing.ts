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
  department: DepartmentEntry | null;
  dateFrom?: string;
  dateTo?: string;
  /** Particular days ("10th or 15th September"); dateFrom/dateTo span them. */
  dates?: string[];
  /** How the range was asked for, e.g. "this week", "21 Sept 2026". */
  rangeLabel: { en: string; hi: string } | null;
  /** Subject words left after removing listing words, dates and the department. */
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
const CONTENT_QUESTION = /\b(?:what does|what do|says?|provisions?|rules? for|eligibility|procedure|process|how to|how do|explain|summar(?:y|ise|ize)|conditions?|limit|entitle|amount of)\b|क्या\s+(?:प्रावधान|नियम|कहता|कहते|शर्त)|प्रावधान|प्रक्रिया|पात्रता|शर्तें|कैसे/;

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

export function detectListingRequest(query: string, today = todayIn()): ListingRequest | null {
  const lower = normalizeDigits(query).toLowerCase();
  if (!ORDER_WORD.test(lower)) return null;
  if (CONTENT_QUESTION.test(lower)) return null;
  const range = parseDateRange(query, today);
  if (!range && !RECENT_WORD.test(lower)) return null;

  const mention = findDepartmentMention(query);
  let rest = ` ${lower} `;
  if (range) rest = rest.replace(range.matched, " ");
  if (mention) {
    // Remove every way the question names this department ("Public Works
    // Department or PWD"), not just the one that matched; otherwise a second
    // name would be taken for a subject word.
    rest = ` ${normalizeName(rest)} `;
    for (const phrase of departmentPhrases(mention.department).sort((a, b) => b.length - a.length)) {
      while (rest.includes(` ${phrase} `)) rest = rest.replace(` ${phrase} `, " ");
    }
  }
  const topicWords = rest
    .replace(/[(),.?!।:;"'/-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !FILLER.has(word) && !/^\d+(?:st|nd|rd|th)?$/.test(word));

  return {
    department: mention?.department ?? null,
    dateFrom: range?.from,
    dateTo: range?.to,
    dates: range?.dates,
    rangeLabel: range?.label ?? null,
    topic: topicWords.length ? topicWords.slice(0, 4).join(" ") : null,
  };
}

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
}

/** Cut at the last space before `max` characters and mark the cut. */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return `${text.slice(0, cut > max * 0.6 ? cut : max).trim()} …`;
}

const displayDate = (value: string | null) =>
  value ? `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}` : "—";

export function buildListingAnswer(request: ListingRequest, outcome: ListingOutcome, language: "hi" | "en"): string {
  const hi = language === "hi";
  const where =
    outcome.scope.kind === "department"
      ? outcome.scope.name
      : outcome.scope.kind === "profile"
        ? hi ? "आपके प्रोफ़ाइल के विभागों" : "your profile departments"
        : hi ? "सभी विभागों" : "all departments";
  const when = request.rangeLabel ? (hi ? request.rangeLabel.hi : request.rangeLabel.en) : null;

  if (!outcome.orders.length) {
    return hi
      ? `संग्रह में ${where}${when ? ` के ${when}` : ""} कोई शासनादेश नहीं मिला। संग्रह अभी पूरा नहीं है; नवीनतम आदेश शासनादेश पोर्टल (shasanadesh.up.gov.in) पर पहले आते हैं।`
      : `No orders ${when ? `${when} ` : ""}were found for ${where} in the archive. The archive is not complete yet; the newest orders appear on the Shasanadesh portal (shasanadesh.up.gov.in) first.`;
  }

  const shown = outcome.orders.length;
  const heading = hi
    ? `**${where}** के ${when ? `${when} के ` : "नवीनतम "}शासनादेश (नए पहले; ${outcome.total} में से ${shown}):`
    : `${when ? `Orders ${when}` : "Latest orders"} for **${where}**, newest first (${shown} of ${outcome.total}):`;

  const lines = outcome.orders.map((order, index) => {
    const number = order.goNumber ? (hi ? `संख्या ${order.goNumber}` : `GO ${order.goNumber}`) : hi ? "संख्या अंकित नहीं" : "number not recorded";
    const subject =
      shorten((order.subject ?? "").replace(/\s+/g, " ").trim(), 220) ||
      (hi ? `विषय अंकित नहीं (आदेश ${order.sourceId})` : `subject not recorded (order ${order.sourceId})`);
    const department = outcome.scope.kind === "department" || !order.department ? "" : ` · ${order.department}`;
    return `${index + 1}. **${displayDate(order.goDate)}** · ${number}${department} — ${subject} [S${index + 1} p.1]`;
  });

  const notes: string[] = [];
  if (outcome.emptyDates?.length) {
    const days = outcome.emptyDates.map(displayDate).join(hi ? " या " : " or ");
    notes.push(hi ? `दिनांक ${days} का कोई शासनादेश संग्रह में नहीं मिला।` : `No orders dated ${days} were found in the archive.`);
  }
  if (outcome.widened) notes.push(hi ? "आपके प्रोफ़ाइल के विभागों में कोई आदेश नहीं मिला, इसलिए सभी विभाग दिखाए गए हैं।" : "Nothing matched in your profile departments, so all departments are shown.");
  if (outcome.topicDropped && request.topic)
    notes.push(hi ? `"${request.topic}" विषय वाला कोई आदेश नहीं मिला, इसलिए सभी आदेश दिखाए गए हैं।` : `No order's subject mentions "${request.topic}", so all orders are shown.`);
  notes.push(
    hi
      ? "यह सूची संग्रह में उपलब्ध आदेशों की है; नवीनतम आदेश पहले शासनादेश पोर्टल पर आते हैं। किसी आदेश की विषय-वस्तु जानने के लिए उसके बारे में पूछें।"
      : "This list covers the orders in the archive; the newest may reach the Shasanadesh portal first. Ask about any of them to see what it says.",
  );

  return [heading, "", ...lines, "", ...notes].join("\n");
}

/**
 * Answer "which orders were issued …" from the order list (ADR-057): newest
 * first, filtered by department and dates. Returns null when the question
 * should go to normal Ask instead (a subject filter matched nothing).
 */
export async function listOrders(
  pool: Pool,
  request: ListingRequest,
  profileDepartments: string[],
  language: "hi" | "en",
): Promise<{ text: string; outcome: ListingOutcome } | null> {
  const base: BrowseRequest = {
    dateFrom: request.dateFrom,
    dateTo: request.dateTo,
    text: request.topic ?? undefined,
    pageSize: 10,
    sort: "date_desc",
  };

  let scope: ListingOutcome["scope"] = { kind: "all" };
  let filters: BrowseRequest = base;
  if (request.department) {
    scope = { kind: "department", name: departmentLabel(request.department, language) };
    filters = { ...base, departmentKeys: [`id:${request.department.id}`] };
  } else if (profileDepartments.length) {
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
      .slice(0, 10);
    return { total: perDay.reduce((sum, day) => sum + day.total, 0), page: 1, pageSize: 10, rows };
  };

  let result = await browse(filters);
  let widened = false;
  if (!result.total && scope.kind === "profile") {
    result = await browse(base);
    scope = { kind: "all" };
    widened = result.total > 0;
  }
  // Subject words that match nothing: with a named department the question is
  // still "that department's orders" (list them, with a note); without one it
  // is a question about content, so Ask handles it.
  let topicDropped = false;
  if (!result.total && request.topic) {
    if (!request.department) return null;
    result = await browse({ ...filters, text: undefined });
    topicDropped = true;
  }

  const outcome: ListingOutcome = {
    orders: result.rows.map((row) => ({
      sourceId: row.sourceId,
      department: row.department,
      goNumber: row.goNumber,
      goDate: row.goDate,
      subject: row.subject,
      sourceUrl: row.sourceUrl,
    })),
    total: result.total,
    scope,
    topicDropped,
    widened,
    emptyDates,
  };
  return { text: buildListingAnswer(request, outcome, language), outcome };
}
