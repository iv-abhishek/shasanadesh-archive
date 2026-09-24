import type { NumericVerificationStatus } from "./types.js";

const RISKY = new Set<NumericVerificationStatus>([
  "conflict",
  "ocr_only_unverified",
  "unverified",
]);

const NUMERIC_RE =
  /[0-9०-९]+(?:[.,:/-][0-9०-९]+)*(?:\s*%)?/gu;

export const UNVERIFIED_NUMERIC =
  "[UNVERIFIED_NUMERIC]";

export function isRiskyNumericStatus(
  status: NumericVerificationStatus,
): boolean {
  return RISKY.has(status);
}

export function prepareEvidenceTextForGeneration(
  text: string,
  status: NumericVerificationStatus,
): string {
  if (!isRiskyNumericStatus(status)) {
    return text;
  }

  // Generator-facing risky evidence must not contain the legacy placeholder token.
  // Remove exact numeric spans instead of replacing them with a copyable sentinel.
  // The model can still use surrounding qualitative text, while deterministic
  // validation remains responsible for blocking unsafe numeric claims.
  return text
    .replace(NUMERIC_RE, "")
    .replace(/\s+%/gu, "")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n[ \t]+/gu, "\n")
    .trim();
}

export function prepareNumericMetadataForGeneration(
  value: string | null | undefined,
  status: NumericVerificationStatus,
): string {
  if (!value) {
    return "unknown";
  }

  return isRiskyNumericStatus(status)
    ? "unverified; check original source page"
    : value;
}
