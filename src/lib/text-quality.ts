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
    score,
    classification,
  };
}
