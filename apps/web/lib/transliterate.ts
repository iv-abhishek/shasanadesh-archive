/**
 * Hinglish → Devanagari typing (ADR-061), entirely in the browser.
 *
 * With Hindi input selected, a word typed in English letters becomes
 * Devanagari when it is finished (space or punctuation): "kya" → "क्या".
 * Candidates come from, in order:
 *   1. a lexicon: common Hindi words (below) plus every well-formed word in the
 *      archive's subjects and clean page text, ranked by frequency
 *      (`npm run translit:lexicon` → /translit/hi-lexicon.json). A typed word
 *      is matched against each lexicon word's casual romanisation — exactly,
 *      then ignoring "a" (schwa / aa), then by consonants only;
 *   2. phonetic rules for anything else.
 * Nothing is sent to a server. Backspace right after a conversion restores the
 * English letters; the suggestion bar offers the alternatives and the original.
 */

// ---------------------------------------------------------------------------
// Devanagari → casual Latin (used to index the lexicon)
// ---------------------------------------------------------------------------

const CONSONANTS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "ळ": "l", "व": "v",
  "श": "sh", "ष": "sh", "स": "s", "ह": "h",
  "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "r", "ढ़": "rh", "फ़": "f", "य़": "y",
};
const NUKTA_FORMS: Record<string, string> = { "क": "क़", "ख": "ख़", "ग": "ग़", "ज": "ज़", "ड": "ड़", "ढ": "ढ़", "फ": "फ़", "य": "य़" };
const INDEPENDENT_VOWELS: Record<string, string> = {
  "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e",
};
const MATRAS: Record<string, string> = {
  "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e",
};
const VIRAMA = "्";
const NUKTA = "़";

/** Hinglish often leaves nasals out: में = "men" or "me", हैं = "hain" or "hai". */
export function romanizeWithoutNasal(word: string): string {
  return romanize(word.replace(/[ंँ]/g, ""));
}

/** "शासनादेश" → "shaasanaadesh" (inherent "a" kept inside the word, dropped at the end). */
export function romanize(word: string): string {
  const chars = [...word.normalize("NFC").replace(/[‌‍]/g, "")];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i];
    if (chars[i + 1] === NUKTA && NUKTA_FORMS[ch]) {
      ch = NUKTA_FORMS[ch];
      i++;
    }
    if (CONSONANTS[ch] !== undefined) {
      out += CONSONANTS[ch];
      const next = chars[i + 1];
      if (next === VIRAMA) {
        i++;
      } else if (next && MATRAS[next] !== undefined) {
        out += MATRAS[next];
        i++;
      } else if (i + 1 < chars.length && !/[ंँः]/.test(next ?? "")) {
        out += "a"; // inherent vowel inside the word
      } else if (/[ंँः]/.test(next ?? "")) {
        out += "a";
      }
    } else if (INDEPENDENT_VOWELS[ch] !== undefined) {
      out += INDEPENDENT_VOWELS[ch];
    } else if (ch === "ं" || ch === "ँ") {
      // Before प फ ब भ म the dot sounds like "m": पंप = "pamp".
      out += /[पफबभम]/.test(chars[i + 1] ?? "") ? "m" : "n";
    } else if (ch === "ः") {
      out += "h";
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keys: how loosely a typed word may match
// ---------------------------------------------------------------------------

/** Spelling habits that do not change the word: aa/a, ee/i, oo/u, w/v, ph/f, doubled letters. */
export function looseKey(latin: string): string {
  return latin
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/w/g, "v")
    .replace(/ph/g, "f")
    .replace(/q/g, "k")
    .replace(/z/g, "j")
    .replace(/x/g, "ks")
    .replace(/ei/g, "e")
    .replace(/ee|ii/g, "i")
    .replace(/oo|uu/g, "u")
    .replace(/([a-z])\1+/g, "$1");
}

/** Without any "a": the inherent vowel and long/short a are what people vary most. */
export function schwaKey(latin: string): string {
  return looseKey(latin).replace(/a/g, "");
}

/** Consonants only (and no aspiration h): the last resort, e.g. "pump" ~ "पंप". */
export function consonantKey(latin: string): string {
  return looseKey(latin).replace(/([bcdgjkpst])h/g, "$1").replace(/[aeiou]/g, "");
}

// ---------------------------------------------------------------------------
// Phonetic rules: Latin → Devanagari for words the lexicon does not know
// ---------------------------------------------------------------------------

const LATIN_CONSONANTS: Array<[string, string]> = [
  ["chh", "छ"], ["ksh", "क्ष"], ["shh", "ष"], ["kh", "ख"], ["gh", "घ"], ["ch", "च"], ["jh", "झ"], ["th", "थ"],
  ["dh", "ध"], ["ph", "फ"], ["bh", "भ"], ["sh", "श"], ["k", "क"], ["g", "ग"], ["c", "क"], ["j", "ज"], ["t", "त"],
  ["d", "द"], ["n", "न"], ["p", "प"], ["b", "ब"], ["m", "म"], ["y", "य"], ["r", "र"], ["l", "ल"], ["v", "व"],
  ["w", "व"], ["s", "स"], ["h", "ह"], ["f", "फ़"], ["z", "ज़"], ["q", "क़"], ["x", "क्स"],
];
const LATIN_VOWELS: Array<[string, string, string]> = [
  // latin, independent, matra ("" = inherent a)
  ["aa", "आ", "ा"], ["ai", "ऐ", "ै"], ["au", "औ", "ौ"], ["ee", "ई", "ी"], ["ii", "ई", "ी"], ["oo", "ऊ", "ू"],
  ["uu", "ऊ", "ू"], ["a", "अ", ""], ["i", "इ", "ि"], ["u", "उ", "ु"], ["e", "ए", "े"], ["o", "ओ", "ो"],
];

function matchAt<T extends [string, ...string[]]>(table: T[], text: string, at: number): T | undefined {
  return table.find(([latin]) => text.startsWith(latin, at));
}

/** "prakriya" → "प्रक्रिया", "kya" → "क्या", "hindi" → "हिंदी". */
export function phoneticToDevanagari(latinWord: string): string {
  const text = latinWord.toLowerCase();
  let out = "";
  let i = 0;
  let afterConsonant = false;
  while (i < text.length) {
    const vowel = matchAt(LATIN_VOWELS, text, i);
    if (vowel) {
      const [latin, independent, matra] = vowel;
      const final = i + latin.length === text.length;
      if (afterConsonant) {
        // Hinglish writes a final long vowel short: "kya", "yojana", "kabhi".
        if (final && latin === "a") out += "ा";
        else if (final && latin === "i") out += "ी";
        else out += matra;
      } else {
        out += independent;
      }
      i += latin.length;
      afterConsonant = false;
      continue;
    }
    const consonant = matchAt(LATIN_CONSONANTS, text, i);
    if (!consonant) {
      i++;
      continue;
    }
    const [latin, dev] = consonant;
    const nextAt = i + latin.length;
    const nextIsConsonant = nextAt < text.length && !matchAt(LATIN_VOWELS, text, nextAt) && Boolean(matchAt(LATIN_CONSONANTS, text, nextAt));
    // n/m before another consonant after a vowel is a nasal: "hindi" → हिंदी, "pump" → पंप.
    if ((latin === "n" || latin === "m") && nextIsConsonant && !afterConsonant && out.length > 0) {
      out += "ं";
      i = nextAt;
      continue;
    }
    if (afterConsonant) out += VIRAMA; // consonant cluster: "pr" → प्र
    out += dev;
    afterConsonant = true;
    i = nextAt;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lexicon lookup
// ---------------------------------------------------------------------------

export type LexiconEntry = [word: string, frequency: number];

interface Indexed {
  word: string;
  frequency: number;
  loose: string;
}

export class Transliterator {
  private exact = new Map<string, Indexed[]>();
  private schwa = new Map<string, Indexed[]>();
  private consonants = new Map<string, Indexed[]>();
  private sortedLoose: Indexed[] = [];

  private aliases: Map<string, string>;

  /**
   * @param entries lexicon words with frequencies
   * @param aliases fixed Hinglish spellings ("mein" → "में") that always win
   */
  constructor(entries: LexiconEntry[], aliases: Record<string, string> = {}) {
    this.aliases = new Map(Object.entries(aliases).map(([latin, word]) => [latin.toLowerCase(), word]));
    const merged = new Map<string, number>();
    for (const [word, frequency] of entries) merged.set(word, (merged.get(word) ?? 0) + frequency);
    for (const [word, frequency] of merged) {
      const latin = romanize(word);
      if (!latin) continue;
      const item: Indexed = { word, frequency, loose: looseKey(latin) };
      // Also without nasals: "men"/"me" both find में.
      for (const key of new Set([item.loose, looseKey(romanizeWithoutNasal(word))])) push(this.exact, key, item);
      push(this.schwa, schwaKey(latin), item);
      const consonantOnly = consonantKey(latin);
      if (consonantOnly.length >= 2) push(this.consonants, consonantOnly, item);
      this.sortedLoose.push(item);
    }
    for (const map of [this.exact, this.schwa, this.consonants]) {
      for (const list of map.values()) list.sort((a, b) => b.frequency - a.frequency);
    }
    this.sortedLoose.sort((a, b) => (a.loose < b.loose ? -1 : a.loose > b.loose ? 1 : b.frequency - a.frequency));
  }

  get size(): number {
    return this.sortedLoose.length;
  }

  /** Best Devanagari spellings for a finished Latin word, best first (never empty). */
  suggest(latinWord: string, limit = 5): string[] {
    const loose = looseKey(latinWord);
    if (!loose) return [];
    const out: string[] = [];
    const add = (items: Indexed[] | undefined) => {
      for (const item of items ?? []) if (!out.includes(item.word)) out.push(item.word);
    };
    const alias = this.aliases.get(latinWord.toLowerCase());
    if (alias) out.push(alias);
    add(this.exact.get(loose));
    add(this.schwa.get(schwaKey(latinWord)));
    if (out.length < limit && consonantKey(latinWord).length >= 3) {
      // Consonants only is loose: same first letter and a similar length.
      add(
        this.consonants
          .get(consonantKey(latinWord))
          ?.filter((item) => item.loose[0] === loose[0] && Math.abs(item.loose.length - loose.length) <= 2)
          .slice(0, 3),
      );
    }
    const rule = phoneticToDevanagari(latinWord);
    if (rule && !out.includes(rule)) {
      // Rules first when the lexicon has nothing close.
      if (out.length) out.push(rule);
      else out.unshift(rule);
    }
    return out.slice(0, limit);
  }

  /** Words starting with what has been typed so far (for the suggestion bar). */
  complete(latinPrefix: string, limit = 3): string[] {
    const prefix = looseKey(latinPrefix);
    if (prefix.length < 3) return [];
    let low = 0;
    let high = this.sortedLoose.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.sortedLoose[mid].loose < prefix) low = mid + 1;
      else high = mid;
    }
    const found: Indexed[] = [];
    for (let i = low; i < this.sortedLoose.length && this.sortedLoose[i].loose.startsWith(prefix) && found.length < 200; i++) {
      found.push(this.sortedLoose[i]);
    }
    return found
      .filter((item) => item.loose !== prefix)
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, limit)
      .map((item) => item.word);
  }
}

function push(map: Map<string, Indexed[]>, key: string, item: Indexed) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

// ---------------------------------------------------------------------------
// Editing: convert the word just finished, undo with Backspace
// ---------------------------------------------------------------------------

const BOUNDARY = /[\s,.?!;:।)\]"']/;

/** Words left alone: acronyms (GO, PWD), anything with digits or search symbols. */
export function shouldTransliterate(word: string, before: string): boolean {
  if (!/^[A-Za-z]+$/.test(word)) return false;
  if (word.length >= 2 && word === word.toUpperCase()) return false; // GO, PWD, DA
  if (/[\d/*?@#_\\-]$/.test(before)) return false; // part of a number, pattern or handle
  return true;
}

export interface Conversion {
  start: number;
  latin: string;
  word: string;
  boundary: string;
}

/**
 * After an edit, if the person just typed a boundary character right after a
 * Latin word, return the text with that word in Devanagari.
 */
export function convertFinishedWord(
  previous: string,
  value: string,
  caret: number,
  convert: (latin: string) => string | undefined,
): { value: string; caret: number; conversion: Conversion } | null {
  if (value.length !== previous.length + 1 || caret < 2) return null;
  const boundary = value[caret - 1];
  if (!BOUNDARY.test(boundary)) return null;
  const head = value.slice(0, caret - 1);
  const match = /[A-Za-z]+$/.exec(head);
  if (!match) return null;
  const latin = match[0];
  const start = head.length - latin.length;
  if (!shouldTransliterate(latin, head.slice(0, start))) return null;
  const word = convert(latin);
  if (!word || word === latin) return null;
  const next = value.slice(0, start) + word + boundary + value.slice(caret);
  return { value: next, caret: start + word.length + 1, conversion: { start, latin, word, boundary } };
}

/** Backspace right after a conversion: put the English letters back. */
export function undoConversion(
  value: string,
  caret: number,
  conversion: Conversion | null,
): { value: string; caret: number } | null {
  if (!conversion) return null;
  const converted = conversion.word + conversion.boundary;
  if (caret !== conversion.start + converted.length || value.slice(conversion.start, caret) !== converted) return null;
  return {
    value: value.slice(0, conversion.start) + conversion.latin + value.slice(caret),
    caret: conversion.start + conversion.latin.length,
  };
}

/** The Latin word being typed at the caret, if any. */
export function wordAtCaret(value: string, caret: number): { start: number; latin: string } | null {
  const match = /[A-Za-z]+$/.exec(value.slice(0, caret));
  if (!match || /[A-Za-z]/.test(value[caret] ?? "")) return null;
  return { start: caret - match[0].length, latin: match[0] };
}

/** Convert a trailing unfinished word (before sending with Enter). */
export function convertTrailingWord(value: string, convert: (latin: string) => string | undefined): string {
  const match = /([A-Za-z]+)(\s*)$/.exec(value);
  if (!match) return value;
  const start = value.length - match[0].length;
  if (!shouldTransliterate(match[1], value.slice(0, start))) return value;
  const word = convert(match[1]);
  return word ? value.slice(0, start) + word + match[2] : value;
}
