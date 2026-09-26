/**
 * Government-order dates arrive in several shapes: our own metadata uses
 * ISO "YYYY-MM-DD"; the Shasanadesh portal listing uses day-first
 * "DD/MM/YYYY" (Indian convention, e.g. "26/09/2026"). Both are converted to
 * ISO for the documents.go_date column. Anything else, or an impossible
 * calendar date, returns null rather than a guess — the raw value is still
 * kept verbatim in documents.metadata.
 */
export function toIsoGoDate(value?: string | null): string | null {
  if (!value) return null;
  const text = value.trim();

  let year: number;
  let month: number;
  let day: number;

  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) {
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
    if (!match) return null;
    [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
