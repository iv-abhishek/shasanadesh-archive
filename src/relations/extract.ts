/**
 * Pipeline stage: document relations (extraction)
 *
 * Purpose:
 *   Find references from one government order to an earlier one ("शासनादेश
 *   संख्या 42/2026/…, दिनांक 21.07.2026 को … संशोधित …") and the kind of link:
 *   supersedes, amends, cancels, corrects (corrigendum) or only refers.
 *
 * Sources and their trade-offs (measured 26–27 Sept):
 *   - portal subject lines: clean Unicode — best source;
 *   - native PDF text: digits correct, Hindi words broken ("शासनादे श", "सं या",
 *     "िदनांक") — patterns below tolerate those spellings;
 *   - OCR text: words clean but digits unreliable (2021 → 202/2024) — not used
 *     for numbers.
 *
 * Invariants:
 *   - a reference needs both a number starting with a digit and a date
 *   - the order's own number/date (its header) is never a reference to itself
 *   - matching to an archived order uses the number's first two parts
 *     ("42/2026") plus the exact date; unmatched references are kept as text
 */

export type RelationKind = "supersedes" | "amends" | "cancels" | "corrects" | "refers";

export interface OrderReference {
  kind: RelationKind;
  /** Number as written, digits normalised. */
  goNumber: string;
  /** "42/2026" — first two parts, for matching. */
  goKey: string;
  /** ISO date. */
  goDate: string;
  /** The words around the reference, for review. */
  evidence: string;
}

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

export function normalizeDigits(text: string): string {
  return text.replace(/[०-९]/g, (digit) => String(DEVANAGARI_DIGITS.indexOf(digit)));
}

/**
 * "42/2026/77-1002-…" → "42/2026"; "160/दस-2012-216/79" → "160/2012": the serial
 * number plus the first four-digit year after it. Enough, with the date, to
 * identify an order across the many GO number styles.
 */
export function goKey(goNumber: string): string | null {
  const text = normalizeDigits(goNumber).replace(/\s+/g, "");
  const serial = /^(\d+)\//.exec(text);
  if (!serial) return null;
  const year = /(?:19|20)\d{2}/.exec(text.slice(serial[0].length));
  return year ? `${Number(serial[1])}/${year[0]}` : null;
}

const MONTHS: Array<[RegExp, number]> = [
  [/^(जन|jan)/i, 1], [/^(फर|feb)/i, 2], [/^(मार्च|माच|mar)/i, 3], [/^(अप्र|अ ैल|अप्रैल|apr)/i, 4],
  [/^(मई|may)/i, 5], [/^(जून|jun)/i, 6], [/^(जुला|jul)/i, 7], [/^(अग|aug)/i, 8],
  [/^(सित|िसत|sep)/i, 9], [/^(अक्टू|अ टू|अक्तू|oct)/i, 10], [/^(नव|nov)/i, 11], [/^(दिस|िदस|dec)/i, 12],
];

export function parseReferenceDate(raw: string): string | null {
  const text = normalizeDigits(raw).trim();
  let day: number;
  let month: number;
  let year: number;
  const numeric = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(text);
  if (numeric) {
    [day, month, year] = [Number(numeric[1]), Number(numeric[2]), Number(numeric[3])];
  } else {
    const worded = /^(\d{1,2})\s+([ऀ-ॿA-Za-z ]{2,12}?),?\s+(\d{4})$/.exec(text);
    if (!worded) return null;
    const found = MONTHS.find(([pattern]) => pattern.test(worded[2].replace(/\s+/g, "")));
    if (!found) return null;
    [day, month, year] = [Number(worded[1]), found[1], Number(worded[3])];
  }
  if (year < 100) year += 2000;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1950 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// "संख्या" and "दिनांक" as written cleanly, in broken native layers, or in English.
const NUMBER_WORD = String.raw`(?:सं\s?ख्?\s?या|सं\s?या|संख्या|सं0|सं\.|No\.?)`;
const DATE_WORD = String.raw`(?:दिनांक|िदनांक|दनांक|िदनाक|दि0|dated|dt\.?)`;
const DATE_VALUE = String.raw`(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[ऀ-ॿA-Za-z ]{2,12}?,?\s+\d{4})`;
const REFERENCE_RE = new RegExp(
  String.raw`${NUMBER_WORD}\s*[:\-–]?\s*(\d[0-9A-Za-zऀ-ॿ()/\-.\s]{0,70}?)\s*[,।]?\s*${DATE_WORD}\s*[:\-–]?\s*${DATE_VALUE}`,
  "gu",
);

// Relation words, tolerant of dropped conjuncts in native text.
const KIND_PATTERNS: Array<[RelationKind, RegExp]> = [
  ["corrects", /शुद्धि\s*-?\s*पत्र|शु\s*ि?\s*-?\s*प\s*त?्?र|corrigendum/i],
  ["cancels", /निरस्त|िनर\s?स?्?त|rescind|cancel|withdrawn/i],
  ["supersedes", /अतिक्रम|अधिक्रम|अ\s?ि?[तध]\s?ि?\s?(?:क्?र)?\s?म[णि]|supersession|supersed/i],
  ["amends", /संशोधन|संशोधित|संशो\s?ि?\s?ध|modif|amend/i],
];

function kindNear(text: string): RelationKind {
  for (const [kind, pattern] of KIND_PATTERNS) if (pattern.test(text)) return kind;
  return "refers";
}

export function extractReferences(
  rawText: string,
  own: { goNumber?: string | null; goDate?: string | null } = {},
): OrderReference[] {
  const text = normalizeDigits(rawText.replace(/[‌‍]/g, "")).replace(/[ \t]+/g, " ");
  const ownKey = own.goNumber ? goKey(own.goNumber) : null;
  const ownDate = own.goDate ? parseReferenceDate(own.goDate) ?? own.goDate : null;
  const matches = [...text.matchAll(REFERENCE_RE)];
  const references: OrderReference[] = [];

  matches.forEach((match, index) => {
    const goNumber = match[1].replace(/\s+/g, "").replace(/[,.।-]+$/, "");
    const key = goKey(goNumber);
    const goDate = parseReferenceDate(match[2]);
    if (!key || !goDate) return;
    if (key === ownKey && goDate === ownDate) return;
    // The relation word usually follows the reference ("… को संशोधित", "… का
    // शुद्धि-पत्र", "… के अतिक्रमण में"); stop at the next reference.
    const end = (match.index ?? 0) + match[0].length;
    const nextStart = matches[index + 1]?.index ?? text.length;
    const after = text.slice(end, Math.min(end + 120, nextStart));
    const before = text.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0);
    references.push({
      kind: kindNear(after) !== "refers" ? kindNear(after) : kindNear(before),
      goNumber,
      goKey: key,
      goDate,
      evidence: text.slice(Math.max(0, (match.index ?? 0) - 40), Math.min(text.length, end + 80)).trim(),
    });
  });

  // One entry per referenced order; the strongest relation wins.
  const rank: Record<RelationKind, number> = { supersedes: 4, cancels: 3, amends: 2, corrects: 2, refers: 0 };
  const byOrder = new Map<string, OrderReference>();
  for (const reference of references) {
    const id = `${reference.goKey}@${reference.goDate}`;
    const existing = byOrder.get(id);
    if (!existing || rank[reference.kind] > rank[existing.kind]) byOrder.set(id, reference);
  }
  return [...byOrder.values()];
}
