#!/usr/bin/env node
/**
 * Pipeline stage: Shasanadesh capture reconciliation (npm run portal:report)
 *
 * Purpose:
 *   One table that answers "is the portal fully captured and archived?":
 *   per listing (department search) the portal total, pages captured vs
 *   expected, orders found, and how many are archived in B2, unavailable,
 *   retrying or still waiting; plus local disk use. Read-only.
 *
 * Reads data/portal-capture/{pages,inventory,ingest-status}.jsonl,
 * complete.json and each order's data/documents/<id>/metadata.json.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const dir = path.resolve("data/portal-capture");
const documentsRoot = path.resolve("data/documents");
const jsonl = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      })
    : [];

const pages = jsonl(path.join(dir, "pages.jsonl"));
const inventory = jsonl(path.join(dir, "inventory.jsonl"));
const statuses = new Map();
for (const row of jsonl(path.join(dir, "ingest-status.jsonl"))) statuses.set(row.sourceId, row.state);
let complete = {};
try {
  const marker = JSON.parse(readFileSync(path.join(dir, "complete.json"), "utf8"));
  complete = marker.listings ?? (marker.expectedRecords ? { legacy: marker } : {});
} catch { /* nothing marked complete yet */ }

const listings = new Map();
const listingOf = (key) => {
  if (!listings.has(key)) listings.set(key, { total: null, pageSize: null, pages: new Set(), rows: 0, reshuffles: 0, orders: [] });
  return listings.get(key);
};
for (const entry of pages) {
  const listing = listingOf(entry.listing ?? "legacy");
  if (entry.reshuffle) { listing.reshuffles++; continue; }
  listing.pages.add(entry.portalPage);
  listing.rows += entry.rowsOnPage ?? 0;
  listing.total = entry.reportedTotal ?? listing.total;
  listing.pageSize = entry.pageSize ?? listing.pageSize ?? 100;
}
for (const record of inventory) listingOf(record.listing ?? "legacy").orders.push(record.sourceId);

let localPdfs = 0;
let localBytes = 0;
let evicted = 0;
for (const record of inventory) {
  const folder = path.join(documentsRoot, record.sourceId.replaceAll("#", "-"));
  const pdf = path.join(folder, "original.pdf");
  if (existsSync(pdf)) {
    localPdfs++;
    localBytes += statSync(pdf).size;
  } else if (existsSync(path.join(folder, "metadata.json"))) {
    try {
      if (JSON.parse(readFileSync(path.join(folder, "metadata.json"), "utf8")).localCopy?.state === "evicted") evicted++;
    } catch { /* unreadable metadata is reported by other tools */ }
  }
}

const pad = (value, width) => String(value).padEnd(width);
const num = (value, width) => String(value).padStart(width);
console.log("Shasanadesh capture reconciliation");
console.log("==================================");
console.log(`${pad("Listing", 44)}${num("Total", 8)}${num("Pages", 12)}${num("Orders", 8)}${num("In B2", 7)}${num("N/A", 6)}${num("Retry", 7)}${num("Waiting", 9)}  State`);
const totals = { orders: 0, archived: 0, unavailable: 0, retry: 0, waiting: 0 };
for (const [key, listing] of [...listings].sort((a, b) => a[0].localeCompare(b[0]))) {
  const expectedPages = listing.total && listing.pageSize ? Math.ceil(listing.total / listing.pageSize) : null;
  const count = (state) => listing.orders.filter((id) => statuses.get(id) === state).length;
  const archived = count("stored") + count("skipped");
  const unavailable = count("unavailable");
  const retry = count("retry");
  const waiting = listing.orders.length - archived - unavailable - retry;
  totals.orders += listing.orders.length; totals.archived += archived; totals.unavailable += unavailable; totals.retry += retry; totals.waiting += waiting;
  const pagesText = `${listing.pages.size}/${expectedPages ?? "?"}`;
  const missingPages = expectedPages ? expectedPages - listing.pages.size : null;
  const shortBy = listing.total ? listing.total - listing.orders.length : null;
  const state = complete[key]
    ? (shortBy && shortBy > 0 ? `complete, ${shortBy} orders fewer than the portal total (reshuffled/duplicate rows)` : "complete")
    : missingPages ? `${missingPages} pages to capture` : "capture open";
  const label = key.replace(/^department=/, "").slice(0, 42);
  console.log(`${pad(label, 44)}${num(listing.total ?? "?", 8)}${num(pagesText, 12)}${num(listing.orders.length, 8)}${num(archived, 7)}${num(unavailable, 6)}${num(retry, 7)}${num(waiting, 9)}  ${state}${listing.reshuffles ? `; ${listing.reshuffles} reshuffled pages` : ""}`);
}
console.log("----------------------------------");
console.log(`Unique orders listed: ${inventory.length} · in B2: ${totals.archived} · unavailable: ${totals.unavailable} · retrying: ${totals.retry} · waiting: ${totals.waiting}`);
console.log(`Local PDFs: ${localPdfs} (${(localBytes / 1e9).toFixed(2)} GB) · routine orders kept only in B2: ${evicted}`);
if (totals.waiting || totals.retry) console.log("Next: npm run ingest:portal -- --until-idle");
