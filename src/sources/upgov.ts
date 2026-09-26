/**
 * Pipeline stage: source discovery
 *
 * Purpose:
 *   Discover Government Orders and Circulars published by the Governor's
 *   Secretariat (Raj Bhavan), Uttar Pradesh, on upgovernor.gov.in.
 *
 * Source quirks:
 *   - The listing pages (/Page/GO, /Page/Circular) render an empty table and
 *     fill it from an ASP.NET page method that returns JSON wrapped as
 *     {"d": "<json string>"}. We call that same public method instead of
 *     scraping HTML.
 *   - Many orders have separate Hindi and English PDFs (NewFileNameHindi /
 *     NewFileNameEnglish; "0" or "" means none). Each edition is archived as
 *     its own document ("…-hi", "…-en") and they point at each other through
 *     relatedSourceIds, so page citations stay exact per PDF.
 *   - Chancellor's Orders (/Page/CollegeOrderList) are deliberately not
 *     included: they are individual quasi-judicial decisions naming private
 *     applicants, not general orders.
 *
 * Invariants:
 *   - the full listing record is kept in sourceRecord
 *   - downloads stay on https://upgovernor.gov.in
 */

import type { SourceAdapter, SourceDocument, SourceLanguage } from "./types.js";
import { politeFetch } from "./http.js";

const HOST = "upgovernor.gov.in";
const ORIGIN = "https://" + HOST;
const ISSUER = "Governor's Secretariat (Raj Bhavan), Uttar Pradesh";
const DEPARTMENT = "Governor's Secretariat";

interface Listing {
  kind: "go" | "circular";
  pageUrl: string;
  methodUrl: string;
  body: string;
  mediaFolder: string;
  documentType: string;
}

const LISTINGS: Listing[] = [
  {
    kind: "go",
    pageUrl: ORIGIN + "/Page/GO",
    methodUrl: ORIGIN + "/Page/GO.aspx/GetUIUpdateSection_Finyrwise",
    // CategoryID 0 = "All" in the page's own category dropdown.
    body: "{CategoryID:'0'}",
    mediaFolder: "GO",
    documentType: "governor-secretariat-order",
  },
  {
    kind: "circular",
    pageUrl: ORIGIN + "/Page/Circular",
    methodUrl: ORIGIN + "/Page/Circular.aspx/GetUIUpdateSection_Finyrwise",
    // finyr 0 = all financial years.
    body: "{finyr:'0'}",
    mediaFolder: "Circulars",
    documentType: "governor-secretariat-circular",
  },
];

type RawRecord = Record<string, unknown>;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed && trimmed !== "0" ? trimmed : null;
}

function isoDate(value: unknown): string | null {
  const raw = text(value);
  const match = raw?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function pdfName(value: unknown): string | null {
  const name = text(value);
  return name && /\.pdf$/i.test(name) ? name : null;
}

/** Parse the {"d": "[...]"} envelope ASP.NET page methods return. */
export function parsePageMethodResponse(payload: unknown): RawRecord[] {
  const d = (payload as { d?: unknown } | null)?.d;
  const parsed = typeof d === "string" ? JSON.parse(d) : d;
  if (!Array.isArray(parsed)) throw new Error("Raj Bhavan listing did not return a record array.");
  return parsed.filter((row): row is RawRecord => Boolean(row) && typeof row === "object");
}

/** Turn listing records into one SourceDocument per language edition. */
export function recordsToDocuments(records: RawRecord[], listing: Listing): SourceDocument[] {
  const documents: SourceDocument[] = [];

  for (const record of records) {
    if (record.IsActive === false) continue;

    const key = listing.kind === "go" ? record.GOKey : record.UpdateSectionKey;
    if (typeof key !== "number" && typeof key !== "string") continue;

    const titles = { hi: text(record.HindiTitle), en: text(record.EnglishTitle) };
    const numbers =
      listing.kind === "go"
        ? { hi: text(record.GONumberHindi), en: text(record.GONumberEnglish) }
        : { hi: text(record.CircularNumberHindi), en: text(record.CircularNumberEnglish) };
    const goDate = isoDate(listing.kind === "go" ? record.GODate : record.UpdateDate);

    const hindiFile = pdfName(record.NewFileNameHindi);
    const englishFile = pdfName(record.NewFileNameEnglish);
    const editions: Array<{ language: SourceLanguage; file: string }> = [];
    if (hindiFile) editions.push({ language: "hi", file: hindiFile });
    if (englishFile && englishFile !== hindiFile) editions.push({ language: "en", file: englishFile });
    // Older rows fill only NewFileName; treat it as the record's stated language.
    if (editions.length === 0) {
      const file = pdfName(record.NewFileName);
      if (!file) continue;
      editions.push({ language: /english/i.test(String(record.Lang ?? "")) ? "en" : "hi", file });
    }

    const idBase = `upgov-${listing.kind}-${String(key).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const ids = editions.map((edition) => `${idBase}-${edition.language}`);

    editions.forEach((edition, index) => {
      const downloadUrl = `${ORIGIN}/MediaGallery/${listing.mediaFolder}/${encodeURIComponent(edition.file)}`;
      const title =
        (edition.language === "hi" ? titles.hi ?? titles.en : titles.en ?? titles.hi) ??
        `${listing.kind === "go" ? "Order" : "Circular"} ${key}`;
      documents.push({
        sourceId: ids[index],
        title,
        sourceUrl: downloadUrl,
        downloadUrl,
        listingUrls: [listing.pageUrl],
        issuer: ISSUER,
        jurisdiction: "state",
        department: DEPARTMENT,
        documentType: listing.documentType,
        goDate,
        goNumber: (edition.language === "hi" ? numbers.hi ?? numbers.en : numbers.en ?? numbers.hi) ?? null,
        language: edition.language,
        titles,
        relatedSourceIds: ids.filter((id) => id !== ids[index]),
        sourceRecord: { ...record, listingKind: listing.kind },
      });
    });
  }

  return documents;
}

async function discover(): Promise<SourceDocument[]> {
  const documents: SourceDocument[] = [];

  for (const listing of LISTINGS) {
    const response = await politeFetch(listing.methodUrl, {
      allowedHosts: [HOST],
      method: "POST",
      body: listing.body,
      accept: "application/json",
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    if (!response.ok) throw new Error(`Raj Bhavan ${listing.kind} listing returned HTTP ${response.status}`);
    documents.push(...recordsToDocuments(parsePageMethodResponse(await response.json()), listing));
  }

  if (documents.length === 0) {
    throw new Error("No Raj Bhavan orders were found; the site may have changed.");
  }
  return documents;
}

export const upgovAdapter: SourceAdapter = {
  id: "upgov",
  collection: "upgov",
  displayName: "Raj Bhavan (Governor's Secretariat), Uttar Pradesh — Government Orders and Circulars",
  allowedHosts: [HOST],
  discover,
};

// Exposed for tests.
export const UPGOV_LISTINGS = LISTINGS;
