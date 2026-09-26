/**
 * The reference line officials paste into their own letters and orders, e.g.
 *   शासनादेश संख्या 61/2023/37-5, दिनांक 15.09.2023
 *   G.O. No. 61/2023/37-5, dated 15.09.2023
 * Dates use the DD.MM.YYYY style common in UP government correspondence.
 * Built only from the order's recorded metadata; nothing is inferred.
 */

export interface ReferenceSource {
  sourceId: string;
  goNumber: string | null;
  goDate: string | null;
  documentTitle?: string | null;
  department?: string | null;
}

/** "2023-09-15" or "15/09/2023" → "15.09.2023"; anything else unchanged. */
export function formatReferenceDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  const dayFirst = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (dayFirst) return `${dayFirst[1].padStart(2, "0")}.${dayFirst[2].padStart(2, "0")}.${dayFirst[3]}`;
  return value;
}

const clean = (value: string | null | undefined) =>
  value ? value.replace(/[‌‍]/g, "").replace(/\s+/g, " ").trim() || null : null;

export function formatGoReference(source: ReferenceSource, language: "hi" | "en"): string {
  const number = clean(source.goNumber);
  const date = formatReferenceDate(source.goDate);
  const title = clean(source.documentTitle) ?? clean(source.department);
  const shasanadesh = /^\d+#\d+#\d+#\d{4}$/.test(source.sourceId);

  if (language === "hi") {
    const kind = shasanadesh ? "शासनादेश" : "आदेश";
    const head = number ? `${kind} संख्या ${number}` : title ? `${kind} (${title})` : kind;
    return date ? `${head}, दिनांक ${date}` : head;
  }

  const kind = shasanadesh ? "G.O." : "Order";
  const head = number ? `${kind} No. ${number}` : title ?? kind;
  return date ? `${head}, dated ${date}` : head;
}
