import type { NumericVerificationStatus } from "./types.js";

const RISKY = new Set<NumericVerificationStatus>([
  "conflict",
  "ocr_only_unverified",
  "unverified",
]);

const NUMERIC_RE =
  /[0-9०-९]+(?:[.,:/-][0-9०-९]+)*/gu;

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

  return text.replace(
    NUMERIC_RE,
    UNVERIFIED_NUMERIC,
  );
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
