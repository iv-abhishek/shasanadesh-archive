/**
 * Legacy Hindi font text (Kruti Dev 010 and its common variants) → Unicode.
 *
 * Purpose:
 *   Many UP government PDFs (the Finance Department's Vitta Path, older GOs)
 *   were typed in the Kruti Dev font. Their text layer holds the font's Latin
 *   codes, so pdftotext returns "foŸkh; vf/kdkj" instead of "वित्तीय अधिकार".
 *   Search, answers and the model cannot use that. The mapping from Kruti Dev
 *   codes to Unicode is fixed, so the text can be converted exactly, which is
 *   more accurate than OCR.
 *
 * How:
 *   1. replace Kruti Dev sequences with Unicode, longest sequence first;
 *   2. move the short-i sign "ि" (typed before its consonant) after the
 *      consonant cluster it belongs to;
 *   3. move the reph "र्" (typed after its syllable as "Z") before that syllable.
 *
 * Detection (looksLikeKrutiDev) is deliberately strict: converting real
 * English text would destroy it, so a page converts only when its common
 * Kruti Dev words clearly outnumber ordinary English words.
 */

/**
 * Kruti Dev sequence → Unicode. Variants seen in Vitta Path PDFs (alternate
 * glyph slots for त्त, ो, ौ, ध्, भ, ०) are included next to the standard ones.
 */
const PAIRS: Array<[string, string]> = [
  // punctuation and digits that the font repurposes
  ["ñ", "॰"], [")Z", "र्द्ध"],
  ["å", "०"], ["Œ", "०"], ["ƒ", "१"], ["„", "२"], ["…", "३"], ["†", "४"], ["‡", "५"], ["ˆ", "६"], ["‰", "७"], ["Š", "८"], ["‹", "९"],
  ["¶+", "फ़्"], ["d+", "क़"], ["[+k", "ख़"], ["[+", "ख़्"], ["x+", "ग़"], ["T+", "ज़्"], ["t+", "ज़"], ["M+", "ड़"], ["<+", "ढ़"], ["Q+", "फ़"], [";+", "य़"], ["j+", "ऱ"], ["u+", "ऩ"],
  // conjuncts
  ["Ùk", "त्त"], ["Ù", "त्त्"], ["Ÿk", "त्त"], ["Ÿ", "त्त्"], ["Ä", "क्त"], ["–", "दृ"], ["—", "कृ"], ["Ñ", "कृ"], ["é", "न्न"], ["™", "न्न्"],
  ["à", "ह्न"], ["á", "ह्य"], ["â", "हृ"], ["ã", "ह्म"], ["ºz", "ह्र"], ["º", "ह्"], ["í", "द्द"],
  ["{k", "क्ष"], ["{", "क्ष्"], ["=", "त्र"], ["«", "त्र्"], ["Nî", "छ्य"], ["Vî", "ट्य"], ["Bî", "ठ्य"], ["Mî", "ड्य"], ["<î", "ढ्य"],
  ["|", "द्य"], ["K", "ज्ञ"], ["}", "द्व"], ["J", "श्र"], ["Vª", "ट्र"], ["Mª", "ड्र"], ["<ª", "ढ्र"], ["Nª", "छ्र"], ["Ø", "क्र"], ["Ý", "फ्र"],
  ["nzZ", "र्द्र"], ["æ", "द्र"], ["ç", "प्र"], ["Á", "प्र"], ["xz", "ग्र"], ["#", "रु"], [":", "रू"],
  // independent vowels
  ["v‚", "ऑ"], ["vks", "ओ"], ["v¨", "ओ"], ["v®", "ओ"], ["vkS", "औ"], ["v©", "औ"], ["vk", "आ"], ["v", "अ"],
  ["b±", "ईं"], ["Ã", "ई"], ["bZ", "ई"], ["b", "इ"], ["m", "उ"], ["Å", "ऊ"], [",s", "ऐ"], [",", "ए"], ["_", "ऋ"],
  // consonants (full form = half form + "k" stroke)
  ["ô", "क्क"], ["d", "क"], ["Dk", "क"], ["D", "क्"], ["[k", "ख"], ["[", "ख्"], ["x", "ग"], ["Xk", "ग"], ["X", "ग्"], ["?k", "घ"], ["?", "घ्"], ["³", "ङ"],
  ["pkS", "चै"], ["p", "च"], ["Pk", "च"], ["P", "च्"], ["N", "छ"], ["t", "ज"], ["Tk", "ज"], ["T", "ज्"], [">", "झ"], ["÷", "झ्"], ["¥", "ञ"],
  ["ê", "ट्ट"], ["ë", "ट्ठ"], ["V", "ट"], ["B", "ठ"], ["ì", "ड्ड"], ["ï", "ड्ढ"], ["M", "ड"], ["<", "ढ"], [".k", "ण"], [".", "ण्"],
  ["r", "त"], ["Rk", "त"], ["R", "त्"], ["Fk", "थ"], ["F", "थ्"], [")", "द्ध"], ["n", "द"], ["/k", "ध"], ["èk", "ध"], ["Ëk", "ध"], ["/", "ध्"], ["è", "ध्"], ["Ë", "ध्"],
  ["u", "न"], ["Uk", "न"], ["U", "न्"], ["i", "प"], ["Ik", "प"], ["I", "प्"], ["Q", "फ"], ["¶", "फ्"], ["c", "ब"], ["Ck", "ब"], ["C", "ब्"],
  ["Hk", "भ"], ["Ò", "भ"], ["H", "भ्"], ["e", "म"], ["Ek", "म"], ["E", "म्"], [";", "य"], ["¸", "य्"], ["j", "र"], ["y", "ल"], ["Yk", "ल"], ["Y", "ल्"], ["G", "ळ"],
  ["o", "व"], ["Ok", "व"], ["O", "व्"], ["'k", "श"], ["'", "श्"], ["\"k", "ष"], ["\"", "ष्"], ["l", "स"], ["Lk", "स"], ["L", "स्"], ["g", "ह"],
  // signs
  ["È", "ीं"], ["z", "्र"], ["Ì", "द्द"], ["Í", "ट्ट"], ["Î", "ट्ठ"], ["Ï", "ड्ड"], ["Ô", "ड्ढ"], ["Ö", "झ्"], ["Ük", "श"], ["Ü", "श्"],
  ["‚", "ॉ"], ["ks", "ो"], ["¨", "ो"], ["®", "ो"], ["kS", "ौ"], ["©", "ौ"], ["k", "ा"], ["h", "ी"], ["q", "ु"], ["w", "ू"], ["`", "ृ"], ["s", "े"], ["¢", "े"], ["S", "ै"],
  ["a", "ं"], ["¡", "ँ"], ["%", "ः"], ["W", "ॅ"], ["•", "ऽ"],
  // Vitta Path uses "·" as a list bullet (the avagraha ऽ is almost never used in office Hindi).
  ["·", "•"], ["~", "्"], ["+", "़"],
  ["A", "।"], ["&", "-"], ["@", "/"], ["¼", "("], ["½", ")"], ["¿", "{"], ["À", "}"], ["Þ", "“"], ["ß", "”"], ["^", "‘"], ["*", "’"], ["]", ","], ["\\", "?"],
  ["ª", "्र"],
];

// "f" (short i) and "Æ" (short i + reph) are positional; they are converted
// in a second step, so the table maps them to markers.
const SHORT_I = "\u{F0001}";
const SHORT_I_REPH = "\u{F0002}";
const REPH = "\u{F0003}";
PAIRS.push(["f", SHORT_I], ["Æ", SHORT_I_REPH], ["Z", REPH]);

const BY_FIRST = new Map<string, Array<[string, string]>>();
for (const pair of [...PAIRS].sort((a, b) => b[0].length - a[0].length)) {
  const list = BY_FIRST.get(pair[0][0]) ?? [];
  list.push(pair);
  BY_FIRST.set(pair[0][0], list);
}

const CONSONANT = "[\\u0915-\\u0939\\u0958-\\u095F]";
// A consonant cluster: half consonants (with optional nukta) then a full one.
const CLUSTER = `(?:${CONSONANT}\\u093C?\\u094D)*${CONSONANT}\\u093C?`;
// Vowel signs, anusvara, chandrabindu, visarga, nukta that follow a cluster.
const SIGNS = "[\\u093C\\u093E-\\u094C\\u0901-\\u0903\\u0945\\u0949]*";

const VOWELS = /[aeiou]/gi;
const ENGLISH_FUNCTION = new Set(["of", "and", "the", "to", "in", "for", "on", "by", "with", "or", "at", "from", "an", "a"]);

/**
 * English typed in a Latin font inside a Kruti Dev page ("(Public Authority)")
 * is indistinguishable at the character level; a capitalised word of 4+
 * letters with English vowel density (a/e/i/o/u ≥ 20%) and no "k" (the Kruti Dev "ा") is
 * English. Single words are protected only inside brackets, runs of two or
 * more anywhere.
 */
/** The word without brackets and trailing punctuation (Kruti Dev "A" is the danda). */
function bareWord(token: string): string {
  return token.replace(/^[¼(]+/, "").replace(/[½)\].,;:]*A?$/, "").replace(/[½)\].,;:]+$/, "");
}

function englishWord(token: string): "strong" | "weak" | null {
  const word = bareWord(token);
  if (ENGLISH_FUNCTION.has(word)) return "weak";
  // Abbreviations (DDO, TDS, VAT) and lower-case words (assessment, tax)
  // count only inside a run that has a capitalised English word.
  if (/^[A-Z]{2,6}$/.test(word)) return "weak";
  const vowelShare = (word.match(VOWELS)?.length ?? 0) / Math.max(word.length, 1);
  if (/^[a-z]{3,}$/.test(word) && !word.includes("k") && vowelShare >= 0.3) return "weak";
  if (!/^[A-Z][a-z]{2,}$/.test(word) || word.includes("k")) return null;
  return vowelShare >= 0.2 ? "strong" : null;
}

function protectEnglish(input: string): Array<{ text: string; english: boolean }> {
  const tokens = input.split(/(\s+)/);
  const english = tokens.map((token) => (/\S/.test(token) ? englishWord(token) : null));
  const keep = tokens.map(() => false);
  for (let i = 0; i < tokens.length; i++) {
    // A bracketed abbreviation on its own, "(DDO)", is English too.
    const lone = english[i] === "weak" && /^[¼(]/.test(tokens[i]) && /[½)]A?$/.test(tokens[i]) && /^[A-Z]{2,6}$/.test(bareWord(tokens[i]));
    if ((english[i] !== "strong" && !lone) || keep[i]) continue;
    // The run of English words (whitespace tokens in between) this word belongs to.
    let start = i;
    let end = i;
    // A run does not cross a bracket: "(Form 16) esa" keeps "esa" (में) Hindi.
    while (start - 2 >= 0 && english[start - 2] && !/^[¼(]/.test(tokens[start]) && !/[½)]A?$/.test(tokens[start - 2])) start -= 2;
    while (end + 2 < tokens.length && english[end + 2] && !/[½)]A?$/.test(tokens[end]) && !/^[¼(]/.test(tokens[end + 2])) end += 2;
    const words = tokens.slice(start, end + 1).filter((token, k) => k % 2 === 0 && !ENGLISH_FUNCTION.has(bareWord(token))).length;
    const bracketed = /^[¼(]/.test(tokens[start]) || /[½)]A?$/.test(tokens[end]);
    if (words >= 2 || bracketed) for (let k = start; k <= end; k++) keep[k] = true;
  }
  const parts: Array<{ text: string; english: boolean }> = [];
  tokens.forEach((token, index) => {
    const last = parts[parts.length - 1];
    const isEnglish = keep[index] || (/^\s+$/.test(token) && keep[index - 1] && keep[index + 1]);
    if (last && last.english === isEnglish) last.text += token;
    else parts.push({ text: token, english: isEnglish });
  });
  return parts;
}

/** Convert Kruti Dev text to Unicode Devanagari. Latin-only text is not touched by callers. */
export function krutiDevToUnicode(raw: string): string {
  return protectEnglish(raw)
    .map((part) =>
      part.english
        ? part.text.replace(/¼/g, "(").replace(/½/g, ")").replace(/\)A$/, ")।").replace(/\]$/, ",")
        : convertSegment(part.text),
    )
    .join("");
}

function convertSegment(raw: string): string {
  // PDF extraction turns the font's ASCII "'" (श्) into a typographic quote,
  // and a doubled reph is one reph.
  // "`" before an amount is the rupee sign of the Rupee fonts (`5,000 → ₹5,000).
  const input = raw.replace(/[’‘]/g, "'").replace(/ZZ/g, "Z").replace(/`(?=\s?\d)/g, "₹");
  let out = "";
  for (let i = 0; i < input.length; ) {
    // A comma between digits is a digit separator (5,000), not the letter ए.
    if (input[i] === "," && /\d/.test(input[i - 1] ?? "") && /\d/.test(input[i + 1] ?? "")) {
      out += ",";
      i += 1;
      continue;
    }
    const candidates = BY_FIRST.get(input[i]);
    const match = candidates?.find(([from]) => input.startsWith(from, i));
    if (match) {
      out += match[1];
      i += match[0].length;
    } else {
      out += input[i];
      i += 1;
    }
  }

  // Short i: typed before the consonant cluster it follows in Unicode.
  out = out.replace(new RegExp(`${SHORT_I}(${CLUSTER})`, "gu"), "$1ि");
  // Short i with reph (Æ): "र्" + cluster + "ि".
  out = out.replace(new RegExp(`${SHORT_I_REPH}(${CLUSTER})`, "gu"), "र्$1ि");
  // Reph: typed after the syllable (cluster and its signs) that carries it.
  out = out.replace(new RegExp(`(${CLUSTER})(${SIGNS})${REPH}`, "gu"), "र्$1$2");
  // Leftover markers (malformed input) become their plain forms.
  out = out.replaceAll(SHORT_I, "ि").replaceAll(SHORT_I_REPH, "ि").replaceAll(REPH, "र्");
  return out
    // A vowel sign typed before the "्र" stroke belongs after it (परिपे्रक्ष्य → परिप्रेक्ष्य).
    .replace(/([\u093E-\u094C])\u094D\u0930/g, "\u094D\u0930$1")
    // ा + ॅ is the ॉ of English loanwords (माॅडल → मॉडल).
    .replace(/\u093E\u0945/g, "\u0949")
    // A sign typed twice (संंविधान) is one sign.
    .replace(/([\u0901-\u0903\u093E-\u094C])\1+/g, "$1");
}

// Frequent Hindi words as Kruti Dev types them: के की का है में और से या कि लिए पर इस को
const KRUTI_WORDS = /(?:^|[\s(,"'-])(?:ds|dh|dk|gS|esa|vkSj|v©j|ls|;k|fd|fy,|ij|bl|dks|d¨|d®|gSa|tks|fd;k|rFkk|vf\/kdkjh|'kklu|Ák\S*|izf\S*)(?=[\s,.;:)\-–—|]|$)/g;
const ENGLISH_WORDS = /\b(?:the|of|and|to|in|is|for|be|by|on|shall|with|or|as|that|any|this|under|from)\b/gi;

/**
 * True when a page's text is Kruti Dev rather than English or Unicode Hindi:
 * enough Kruti Dev function words, clearly more than English function words,
 * and little real Devanagari.
 */
export function looksLikeKrutiDev(text: string): boolean {
  const devanagari = (text.match(/[ऀ-ॿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (latin < 40 || devanagari > latin * 0.2) return false;
  const kruti = (text.match(KRUTI_WORDS) ?? []).length;
  const english = (text.match(ENGLISH_WORDS) ?? []).length;
  return kruti >= 5 && kruti > english * 2;
}
