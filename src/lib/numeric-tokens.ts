/**
 * Shared numeric-token extraction for native/OCR conflict detection.
 *
 * Government orders mix ASCII digits (2020) and Devanagari digits (२०२०).
 * Both are normalised to ASCII before comparison so that:
 *   - a page whose variants differ only in Devanagari digits is flagged as a
 *     numeric conflict (previously these digits were ignored entirely); and
 *   - the same number written in different scripts is not a false conflict.
 */

const DEVANAGARI_ZERO = 0x0966;

export function toAsciiDigits(text: string): string {
  return text.replace(/[०-९]/gu, (digit) =>
    String(digit.codePointAt(0)! - DEVANAGARI_ZERO),
  );
}

export function numericTokens(text: string): string[] {
  const normalized = toAsciiDigits(text.normalize("NFKC"));

  return [
    ...new Set(
      (normalized.match(/\d[\d.,:/()\-]*/gu) ?? []).map((token) =>
        token.replace(/[.,;:]+$/g, ""),
      ),
    ),
  ];
}
