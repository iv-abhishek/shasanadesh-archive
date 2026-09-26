/**
 * Fixture tests for the official-source adapters. Fixtures in ./fixtures are
 * trimmed copies of the live listing pages (captured 2026-09-26); if a site
 * changes its markup, refresh the fixture and adjust the parser together.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parsePageMethodResponse, recordsToDocuments, UPGOV_LISTINGS } from "./upgov.js";
import { lastGoPage, parseGoPage, parseNotifications } from "./invest-up.js";
import { mergeListings, parseGovOrderTable } from "./uppolice.js";
import { parseRobots, robotsAllows } from "./http.js";
import { listSourceAdapters } from "./registry.js";

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "fixtures", name), "utf8");

// --- Raj Bhavan -------------------------------------------------------------
{
  const [goListing, circularListing] = UPGOV_LISTINGS;
  const goDocs = recordsToDocuments(parsePageMethodResponse(JSON.parse(fixture("upgov-go.json"))), goListing);
  // GOKey 61: Hindi only; GOKey 29: Hindi + English; GOKey 7: inactive, skipped.
  assert.deepEqual(goDocs.map((doc) => doc.sourceId), ["upgov-go-61-hi", "upgov-go-29-hi", "upgov-go-29-en"]);
  const [only, hi, en] = goDocs;
  assert.equal(only.downloadUrl, "https://upgovernor.gov.in/MediaGallery/GO/C_202501231300124641.pdf");
  assert.equal(only.goNumber, "जी-114/2025");
  assert.equal(only.goDate, "2025-01-22");
  assert.equal(only.language, "hi");
  assert.deepEqual(only.relatedSourceIds, []);
  assert.equal(hi.downloadUrl.endsWith("C_202105241438281676.pdf"), true);
  assert.equal(en.downloadUrl.endsWith("C_202105241438151145.pdf"), true);
  assert.ok(en.title.startsWith("Order for adopting uniform selection"));
  assert.ok(hi.title.startsWith("उत्तर प्रदेश में राज्य विश्वविद्यालयों"));
  assert.deepEqual(hi.relatedSourceIds, ["upgov-go-29-en"]);
  assert.equal(hi.sourceRecord?.GOKey, 29, "listing record kept verbatim");
  assert.equal(hi.department, "Governor's Secretariat");

  const circulars = recordsToDocuments(parsePageMethodResponse(JSON.parse(fixture("upgov-circular.json"))), circularListing);
  assert.deepEqual(circulars.map((doc) => doc.sourceId), ["upgov-circular-292-hi", "upgov-circular-292-en"]);
  assert.equal(circulars[0].downloadUrl, "https://upgovernor.gov.in/MediaGallery/Circulars/C_202105282152267368.pdf");
  assert.equal(circulars[0].goDate, "2021-05-28");
  assert.equal(circulars[0].documentType, "governor-secretariat-circular");
}

// --- Invest UP ---------------------------------------------------------------
{
  const html = fixture("invest-up-gos.html");
  const docs = parseGoPage(html, "https://invest.up.gov.in/gos/");
  assert.equal(docs.length, 2, "off-site PDF ignored");
  assert.equal(docs[0].goDate, "2026-09-11");
  assert.equal(docs[0].documentType, "revision-order");
  assert.match(docs[0].sourceId, /^invest-up-[0-9a-f]{20}$/);
  assert.equal(docs[1].goDate, null, "invalid -0001 date becomes null");
  assert.ok(docs[1].downloadUrl.startsWith("https://invest.up.gov.in/wp-content/uploads/2024/03/"));
  assert.equal(lastGoPage(html), 40);

  const notes = parseNotifications(fixture("invest-up-notifications.html"), "https://invest.up.gov.in/notifications/");
  assert.equal(notes.length, 2);
  assert.equal(notes[0].title, "UP Social Security Rules 2026");
  assert.equal(notes[0].goDate, "2026-08-27");
  assert.equal(notes[0].language, "en");
  assert.equal(notes[0].documentType, "notification");
  assert.equal(notes[0].downloadUrl, "https://invest.up.gov.in/wp-content/uploads/2026/09/478-rph-shram-anubhag-Hindi-English_060926.pdf");
}

// --- UP Police ---------------------------------------------------------------
{
  const hi = parseGovOrderTable(fixture("uppolice-hi.html"), "https://uppolice.gov.in/article/hi/gov-order");
  const en = parseGovOrderTable(fixture("uppolice-en.html"), "https://uppolice.gov.in/article/en/gov-order");
  // Shasanadesh, ndal-alis and legislative.gov.in links are skipped.
  assert.equal(hi.length, 7);
  assert.equal(en.length, 3);
  assert.equal(hi[0].url, "https://uppolice.gov.in/site/writereaddata/siteContent/Govt%20Order/202012101149413698important%20go.pdf");
  assert.ok(hi.some((link) => link.url.endsWith(".PDF")), "upper-case .PDF accepted");

  const docs = mergeListings(hi, en);
  assert.equal(docs.length, 7, "same PDF on both pages is one document");
  const ta = docs.find((doc) => doc.sourceRecord?.fileName === "202012101149413698important go.pdf")!;
  assert.equal(ta.titles?.hi, "उत्तर प्रदेश यात्रा भत्ता शासनादेश 2019");
  assert.equal(ta.titles?.en, "Uttar Pradesh Travelling Allowance Government Order 2019");
  assert.equal(ta.listingUrls.length, 2);
  assert.equal(ta.sourceRecord?.uploadDateHint, "2020-12-10");
  assert.equal(ta.goDate, null, "upload timestamp is not used as the order date");
  const cyber = docs.find((doc) => doc.title.includes("IG Cyber Crime"))!;
  assert.equal(cyber.goDate, "2019-08-30");
  assert.equal(cyber.documentType, "notification");
  assert.equal(cyber.goNumber, "63/2019/1106-p-6-pu-6-2016-300(13)2014");
  const writ = docs.find((doc) => doc.title.includes("रिट"))!;
  assert.equal(writ.documentType, "court-compliance-order");
}

// --- Crawl policy ------------------------------------------------------------
{
  const rules = parseRobots(
    "User-agent: *\nDisallow: /admin\nAllow: /admin/public\n\nUser-agent: OtherBot\nDisallow: /\n",
    "ShasanadeshArchive/0.1 (government document research)",
  );
  assert.equal(robotsAllows(rules, "/GO/ViewGOPDF_list_user.aspx?id1=x"), true);
  assert.equal(robotsAllows(rules, "/admin/secret"), false);
  assert.equal(robotsAllows(rules, "/admin/public/a.pdf"), true);
  const ours = parseRobots("User-agent: ShasanadeshArchive\nDisallow: /GO/\n", "ShasanadeshArchive/0.1");
  assert.equal(robotsAllows(ours, "/GO/ViewGOPDF_list_user.aspx"), false);
}

// --- Separation --------------------------------------------------------------
{
  const adapters = listSourceAdapters();
  const collections = adapters.map((adapter) => adapter.collection);
  assert.equal(new Set(collections).size, collections.length, "each adapter has its own collection");
  for (const adapter of adapters) assert.equal(adapter.id, adapter.collection, `${adapter.id}: provider = collection`);
}

console.log("source adapter tests passed");
