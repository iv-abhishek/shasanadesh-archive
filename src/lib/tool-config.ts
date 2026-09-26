/**
 * External tool and crawl settings, read from the environment with the
 * defaults documented in docs/CONFIGURATION.md.
 */

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const OCR_LANGS = process.env.OCR_LANGS?.trim() || "hin+eng";
export const OCR_DPI = positiveInt(process.env.OCR_DPI, 300);

export const TESSERACT_BIN = process.env.TESSERACT_BIN?.trim() || "tesseract";
export const PDFTOPPM_BIN = process.env.PDFTOPPM_BIN?.trim() || "pdftoppm";
export const PDFTOTEXT_BIN = process.env.PDFTOTEXT_BIN?.trim() || "pdftotext";
export const PDFINFO_BIN = process.env.PDFINFO_BIN?.trim() || "pdfinfo";

export const DEFAULT_CRAWLER_USER_AGENT =
  "ShasanadeshArchive/0.1 (government document research)";

export function crawlerUserAgent(override?: string): string {
  return (
    override?.trim() ||
    process.env.CRAWLER_USER_AGENT?.trim() ||
    DEFAULT_CRAWLER_USER_AGENT
  );
}

/** Delay between requests to one government site; never below 3 seconds. */
export function crawlDelayMs(minimum = 3000): number {
  return Math.max(minimum, positiveInt(process.env.CRAWL_DELAY_MS, minimum));
}
