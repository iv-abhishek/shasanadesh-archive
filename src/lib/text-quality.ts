/**
 * Shared text-quality scoring for native PDF extraction and OCR comparison.
 *
 * Keep ALL page-quality thresholds here so diagnostic and repair scripts cannot
 * silently drift apart.
 */

export interface TextQualityMetrics {
  chars: number;
  devanagariChars: number;
  combiningMarks: number;
  markRatio: number;
  tokenCount: number;
  avgTokenLength: number;
  singleCharDevanagariTokens: number;
  singleCharRatio: number;
  viramaVowelAnomalies: number;
  replacementChars: number;
  /** Zero-width joiners/non-joiners (U+200C/U+200D). */
  joinerChars: number;
  /** Joiners per Devanagari character. */
  joinerRatio: number;
  /**
   * Letters that ordinary Hindi text almost never uses (currently U+0904 "ऄ").
   * Broken legacy-font mappings emit it in place of "अ".
   */
  rareLetterChars: number;
  /**
   * Devanagari words that start with a dependent vowel sign or other mark
   * ("िनयम", "ोटोटाइप"). Impossible in real Hindi; produced when a PDF's font
   * mapping drops conjuncts ("प्रसूति" → "सूित", "उत्तर प्रदेश" → "उ तर दे श").
   */
  leadingMarkTokens: number;
  leadingMarkRatio: number;
  score: number;
  classification: "ok" | "review" | "suspicious";
}

function countMatches(text: string, regex: RegExp): number {
  return [...text.matchAll(regex)].length;
}

export function normalizeText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Heuristic quality score used by BOTH native-page audit and selective OCR.
 *
 * This intentionally reproduces the scoring logic used by the original
 * native-page audit so a threshold such as <=55 means the same thing
 * everywhere.
 *
 * It is a triage score, not proof that the text is correct/incorrect.
 */
export function analyzeTextQuality(textInput: string): TextQualityMetrics {
  const text = normalizeText(textInput);
  const chars = text.length;

  const devanagariChars = countMatches(text, /[\u0900-\u097F]/gu);
  const combiningMarks = countMatches(text, /\p{M}/gu);

  const tokens = text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const devTokens = tokens.filter((token) =>
    /[\u0900-\u097F]/u.test(token),
  );

  const singleCharDevanagariTokens = devTokens.filter((token) => {
    const bases = token.match(/\p{L}/gu) ?? [];
    return bases.length === 1 && token.length <= 2;
  }).length;

  const tokenCount = devTokens.length;

  const avgTokenLength =
    tokenCount > 0
      ? devTokens.reduce((sum, token) => sum + token.length, 0) / tokenCount
      : 0;

  const singleCharRatio =
    tokenCount > 0 ? singleCharDevanagariTokens / tokenCount : 0;

  const markRatio =
    devanagariChars > 0 ? combiningMarks / devanagariChars : 0;

  // Broken PDF ToUnicode mappings often generate impossible-looking sequences
  // such as virama immediately followed by a dependent vowel sign: "्े".
  const viramaVowelAnomalies = countMatches(
    text,
    /\u094D[\u093E-\u094C\u0962\u0963]/gu,
  );

  const replacementChars = countMatches(text, /\uFFFD/gu);

  // Legacy Krutidev-style fonts exported through a broken ToUnicode map put
  // U+200D where spaces belong and U+0904 where "अ" belongs, and drop letters
  // (e.g. "पंप" becomes " म्"). The text looks plausible to the ratios above,
  // so these two signals are scored separately.
  const joinerChars = countMatches(text, /[\u200C\u200D]/gu);
  const joinerRatio =
    devanagariChars > 0 ? joinerChars / devanagariChars : 0;
  const rareLetterChars = countMatches(text, /\u0904/gu);

  // Broken-conjunct text layers (measured 26 Sept: ~190 of 196 indexed native
  // Shasanadesh pages) look plausible to the ratios above. Measure over the
  // text without joiners so ZWJ-split words are not double counted.
  const devanagariWords = text.replace(/[\u200C\u200D]/g, "").match(/[\u0900-\u0963\u0966-\u097F]+/gu) ?? [];
  const leadingMarkTokens = devanagariWords.filter((word) => /^[\u0900-\u0903\u093A-\u094F\u0955-\u0957\u0962\u0963]/u.test(word)).length;
  const leadingMarkRatio = devanagariWords.length > 0 ? leadingMarkTokens / devanagariWords.length : 0;

  let score = 100;

  if (devanagariChars >= 100) {
    if (markRatio < 0.07) score -= 25;
    else if (markRatio < 0.10) score -= 12;

    if (avgTokenLength > 0 && avgTokenLength < 2.6) score -= 20;
    else if (avgTokenLength > 0 && avgTokenLength < 3.0) score -= 10;

    // Preserve the original audit behavior exactly. This is deliberately
    // aggressive and is why this score is for triage, not automatic replacement.
    score -= Math.min(30, singleCharRatio * 100);
  }

  score -= Math.min(35, viramaVowelAnomalies * 7);
  score -= Math.min(30, replacementChars * 5);

  // A handful of joiners is legitimate (half-forms, some names). Dozens at a
  // rate above 2% of Devanagari characters is a broken font mapping.
  if (joinerChars >= 20 && joinerRatio > 0.02) {
    score -= Math.min(50, 20 + Math.round(joinerRatio * 150));
  }

  score -= Math.min(30, rareLetterChars * 3);

  // Clean Hindi has none; broken layers measured 0.016–0.22.
  if (leadingMarkTokens >= 3 && leadingMarkRatio >= 0.01) {
    score -= Math.min(45, 15 + Math.round(leadingMarkRatio * 300));
  }

  score = Math.max(0, Math.round(score));

  const classification: TextQualityMetrics["classification"] =
    score < 60 ? "suspicious" : score < 78 ? "review" : "ok";

  return {
    chars,
    devanagariChars,
    combiningMarks,
    markRatio,
    tokenCount,
    avgTokenLength,
    singleCharDevanagariTokens,
    singleCharRatio,
    viramaVowelAnomalies,
    replacementChars,
    joinerChars,
    joinerRatio,
    rareLetterChars,
    leadingMarkTokens,
    leadingMarkRatio,
    score,
    classification,
  };
}
