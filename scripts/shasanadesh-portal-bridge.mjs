#!/usr/bin/env node
/**
 * Pipeline stage: Shasanadesh listing capture (npm run portal:bridge)
 *
 * Purpose:
 *   A loopback-only helper that receives the rows of a Shasanadesh results
 *   page — after a person has run the portal search and completed its CAPTCHA
 *   in their own browser — and appends them to data/portal-capture/.
 *   The bridge never talks to the portal, and never solves or bypasses a CAPTCHA.
 *
 * How rows arrive:
 *   1. Capture bookmark (scripts/portal-bookmark.js, served on the bridge page
 *      with the token): reads the results table in the portal tab and POSTs it
 *      to /api/batch; on request it then follows the portal's "Next" pager in
 *      the same browser session (no CAPTCHA involved) until the last page. Chrome may ask once to allow the portal to reach
 *      "devices on your local network" (the bridge on 127.0.0.1).
 *   2. Fallback: the bookmark copies the JSON; paste it into the form here.
 *
 * Listings (per-department capture):
 *   Every page belongs to a listing = the portal's search filters (department,
 *   section, category, dates). Page numbers are per listing, so a department's
 *   page 1 does not clash with another's. A listing is complete when every page
 *   1..ceil(total/pageSize) has been captured and its rows reach the portal's
 *   total. Pages captured before listings existed belong to "legacy".
 *
 * Invariants:
 *   - accepts only official links https://shasanadesh.up.gov.in/GO/ViewGOPDF_list_user.aspx?id1=…
 *     whose id decodes to a Shasanadesh ID; everything else in a row is optional text
 *   - append-only files; a page re-sent with the same orders is ignored, with
 *     different orders it is recorded as a "reshuffle" (the portal's date-sorted
 *     listing repeats and skips rows), never silently merged
 *   - binds to 127.0.0.1 only; state-changing requests need the per-run token
 */
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.PORTAL_BRIDGE_PORT ?? "8799", 10);
const DATA_DIR = path.resolve("data/portal-capture");
const INVENTORY_PATH = path.join(DATA_DIR, "inventory.jsonl");
const PAGES_PATH = path.join(DATA_DIR, "pages.jsonl");
const COMPLETE_PATH = path.join(DATA_DIR, "complete.json");
const PAGING_STATE_PATH = path.join(DATA_DIR, "paging-state.json");
const PORTAL_ORIGIN = "https://shasanadesh.up.gov.in";
const MAX_BODY_BYTES = 2_000_000;
const LEGACY_LISTING = "legacy";
// The capture bookmark embeds this token. It is kept in data/portal-capture/
// .bridge-token (not in git) so a bookmark keeps working after the bridge is
// stopped and started again; delete that file to issue a new one.
const TOKEN_PATH = path.join(DATA_DIR, ".bridge-token");
const formToken = await (async () => {
  try {
    const saved = (await readFile(TOKEN_PATH, "utf8")).trim();
    if (/^[0-9a-f]{48}$/.test(saved)) return saved;
  } catch {
    /* first run */
  }
  const fresh = randomBytes(24).toString("hex");
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TOKEN_PATH, fresh + "\n", { mode: 0o600 });
  return fresh;
})();

const seenIds = new Set();
/** Orders whose inventory line has no row details (captured by the old bookmark). */
const thinIds = new Set();
const isThin = (record) => !record.subject && !record.goDate;
/** listingKey -> { filters, pages: Map<page, digest>, rows, uniqueAdded, reportedTotal, pageSize, reshuffles } */
const listings = new Map();
let completeMarker = { listings: {} };

function listingKeyOf(filters) {
  if (!filters) return LEGACY_LISTING;
  const parts = ["department", "section", "category", "dateFrom", "dateTo", "goNumber", "subject"]
    .map((key) => (typeof filters[key] === "string" && filters[key].trim() ? `${key}=${filters[key].trim()}` : null))
    .filter(Boolean);
  return parts.length ? parts.join(" | ") : "all orders";
}

function listingFor(key, filters) {
  let listing = listings.get(key);
  if (!listing) {
    listing = { filters: filters ?? null, pages: new Map(), rows: 0, uniqueAdded: 0, reportedTotal: null, pageSize: null, reshuffles: 0 };
    listings.set(key, listing);
  }
  return listing;
}

function expectedPages(listing) {
  return listing.reportedTotal && listing.pageSize ? Math.ceil(listing.reportedTotal / listing.pageSize) : null;
}

function missingPages(listing) {
  const expected = expectedPages(listing);
  if (!expected) return null;
  const missing = [];
  for (let page = 1; page <= expected; page++) if (!listing.pages.has(page)) missing.push(page);
  return missing;
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

/**
 * The bookmark's code lives in scripts/portal-bookmark.js; it runs inside the
 * portal tab, reads the results table and can follow the portal's own "Next"
 * link page by page (see that file). A dragged bookmark holds a copy of the
 * code, so after editing that file the bookmark has to be dragged again.
 */
const BOOKMARK_SOURCE = new URL("./portal-bookmark.js", import.meta.url);

function captureScript(token) {
  const code = readFileSync(BOOKMARK_SOURCE, "utf8")
    .replace('"__BRIDGE__"', JSON.stringify(`http://${HOST}:${PORT}`))
    .replace('"__TOKEN__"', JSON.stringify(token));
  return "javascript:" + encodeURIComponent(code);
}

function page(message = "") {
  const rows = [...listings.entries()].map(([key, listing]) => {
    const expected = expectedPages(listing);
    const missing = missingPages(listing);
    const complete = Boolean(completeMarker.listings?.[key]);
    return `<tr><td>${htmlEscape(key)}</td><td>${listing.pages.size}${expected ? ` / ${expected}` : ""}</td><td>${listing.rows}</td><td>${listing.uniqueAdded}</td><td>${listing.reportedTotal ?? "?"}</td><td>${listing.reshuffles}</td><td>${complete ? "complete" : missing && missing.length ? `missing ${htmlEscape(missing.slice(0, 8).join(", "))}${missing.length > 8 ? " …" : ""}` : "open"}</td>
<td>${complete ? "" : `<form method="post" action="/complete" style="margin:0"><input type="hidden" name="token" value="${formToken}"><input type="hidden" name="listing" value="${htmlEscape(key)}"><button type="submit">Mark complete</button></form>`}</td></tr>`;
  }).join("");
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Shasanadesh portal bridge</title>
<style>
body{font:15px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#18212b}
textarea{width:100%;height:12rem;font:13px ui-monospace,monospace} input{font:inherit;padding:.3rem}
button{font:inherit;padding:.4rem .8rem} .status{padding:.8rem;background:#edf6ee;white-space:pre-wrap}
table{border-collapse:collapse;width:100%;margin:1rem 0} td,th{border-bottom:1px solid #d8dfda;padding:.4rem;text-align:left;font-size:14px}
.bookmark{display:inline-block;padding:.5rem .9rem;background:#246b50;color:#fff;border-radius:8px;text-decoration:none;font-weight:700}
</style>
<h1>Shasanadesh portal bridge</h1>
<p>Loopback only. Receives rows from a Shasanadesh search that <strong>you</strong> ran in your browser (CAPTCHA completed by you). Unique orders saved: <strong>${seenIds.size}</strong>.</p>
${message ? `<p class="status">${htmlEscape(message)}</p>` : ""}
<h2>1. Capture bookmark</h2>
<p>Drag this to your bookmarks bar: <a class="bookmark" href="${captureScript(formToken)}">Capture Shasanadesh page</a>
(it keeps working after the bridge restarts). Click it on the <b>Shasanadesh results tab</b>, not on this page.</p>
<ol>
<li>On shasanadesh.up.gov.in choose <strong>one department</strong>, dates 01/01/1947 to today and <strong>100</strong> records per page, complete the CAPTCHA and search.</li>
<li>Click the bookmark once on the results. It saves page 1 and offers to capture the remaining pages by itself, one every few seconds, using the portal's own "Next" link. Keep the tab open and the Mac awake; a box at the bottom right shows progress and has a Stop button. Chrome may ask once to let the site reach your local network — allow it (only 127.0.0.1 is contacted).</li>
<li>When it finishes, check the row below: rows should reach the portal total. Then press <em>Mark complete</em> and search the next department.</li>
</ol>
<h2>2. Listings</h2>
<table><tr><th>Listing (portal filters)</th><th>Pages</th><th>Rows</th><th>New orders</th><th>Portal total</th><th>Reshuffled pages</th><th>State</th><th></th></tr>${rows || '<tr><td colspan="8">Nothing captured yet.</td></tr>'}</table>
<p>After capture: <code>npm run portal:report</code> reconciles listings, downloads and B2.</p>
<details><summary>Fallback: paste a copied page</summary>
<form method="post" action="/batch">
  <input type="hidden" name="token" value="${formToken}">
  <p>Paste the JSON the bookmark copied (it includes the listing, page and total):</p>
  <textarea name="batch" required spellcheck="false" autocomplete="off"></textarea>
  <p><button type="submit">Append this page</button></p>
</form></details>
<details><summary>Refresh resumable browser paging state</summary>
<form method="post" action="/state"><input type="hidden" name="token" value="${formToken}"><p>Paste the page's non-cookie ASP.NET form state (CAPTCHA value excluded):</p>
<textarea name="state" required spellcheck="false" autocomplete="off"></textarea><button type="submit">Save paging state</button></form></details>
</html>`;
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error("Request body exceeds the 2 MB bridge limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function decodeOrderId(base64) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("Malformed order identifier.");
  const value = Buffer.from(base64, "base64").toString("utf8");
  if (!/^\d+#\d+#\d+#\d{4}$/.test(value)) throw new Error(`Unexpected order identifier: ${value}`);
  return value;
}

class LinkError extends Error {}

function validateRecord(record, portalPage, listingKey) {
  if (!record || typeof record !== "object") throw new Error("Batch contains a non-object record.");
  let sourceUrl;
  try {
    sourceUrl = new URL(record.sourceUrl);
  } catch {
    throw new LinkError(`not a link: ${String(record.sourceUrl).slice(0, 120)}`);
  }
  // The portal is reached as http or https, with or without "www.", and the
  // path's letter case varies; all are the same official endpoint, stored in
  // one canonical form.
  const host = sourceUrl.hostname.toLowerCase().replace(/^www\./, "");
  // shasanadesh.up.nic.in is the portal's older address for the same application.
  if (!["shasanadesh.up.gov.in", "shasanadesh.up.nic.in"].includes(host) || sourceUrl.pathname.toLowerCase() !== "/go/viewgopdf_list_user.aspx") {
    throw new LinkError(`not the official PDF endpoint: ${sourceUrl.href.slice(0, 120)}`);
  }
  sourceUrl = new URL(`${PORTAL_ORIGIN}/GO/ViewGOPDF_list_user.aspx${sourceUrl.search}`);
  const encodedId = sourceUrl.searchParams.get("id1");
  if (!encodedId) throw new Error("A PDF link is missing its order identifier.");
  const sourceId = decodeOrderId(encodedId);
  if (record.sourceId && record.sourceId !== sourceId) throw new Error("Record ID does not match its official PDF link.");
  const strings = ["department", "section", "goNumber", "goDate", "category", "subject", "linkText"];
  const clean = {};
  for (const key of strings) {
    const value = record[key];
    if (value !== null && value !== undefined && typeof value !== "string") {
      throw new Error(`Record field ${key} must be text or null.`);
    }
    clean[key] = typeof value === "string" ? value.trim().slice(0, 2000) || null : null;
  }
  return {
    sourceId,
    encodedId,
    sourceUrl: sourceUrl.href,
    portalPage,
    portalRow: Number.isInteger(record.portalRow) ? record.portalRow : null,
    listing: listingKey,
    capturedAt: new Date().toISOString(),
    ...clean,
  };
}

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  for (const line of (await readFile(INVENTORY_PATH, "utf8").catch(() => "")).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      seenIds.add(record.sourceId);
      if (isThin(record)) thinIds.add(record.sourceId);
      else thinIds.delete(record.sourceId);
    } catch { /* the importer reports malformed inventory */ }
  }
  for (const line of (await readFile(PAGES_PATH, "utf8").catch(() => "")).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const key = entry.listing ?? LEGACY_LISTING;
      const listing = listingFor(key, entry.filters);
      if (entry.reportedTotal) listing.reportedTotal = entry.reportedTotal;
      if (entry.resetPages) {
        listing.pages.clear();
        listing.rows = 0;
        listing.pageSize = entry.pageSize ?? null;
        continue;
      }
      if (entry.detailsOnly) continue;
      if (entry.reshuffle) {
        listing.reshuffles += 1;
        continue;
      }
      listing.pages.set(entry.portalPage, entry.pageDigest ?? null);
      listing.rows += Number(entry.rowsOnPage) || 0;
      listing.uniqueAdded += Number(entry.uniqueAdded) || 0;
      listing.reportedTotal = entry.reportedTotal ?? listing.reportedTotal;
      listing.pageSize = entry.pageSize ?? listing.pageSize ?? (key === LEGACY_LISTING ? 100 : null);
    } catch { /* malformed ledger lines are not counted */ }
  }
  try {
    const marker = JSON.parse(await readFile(COMPLETE_PATH, "utf8"));
    completeMarker = marker.listings ? marker : { ...marker, listings: {} };
  } catch {
    completeMarker = { listings: {} };
  }
}

/** Shared by the bookmark (JSON) and the paste form. */
async function acceptBatch(batch) {
  const portalPage = Number.parseInt(String(batch.portalPage ?? ""), 10);
  const reportedTotal = Number.parseInt(String(batch.reportedTotal ?? ""), 10);
  if (!Number.isInteger(portalPage) || portalPage < 1 || !Number.isInteger(reportedTotal) || reportedTotal < 1) {
    throw new Error("Page number and portal total must be positive integers.");
  }
  const records = Array.isArray(batch) ? batch : batch.records;
  if (!Array.isArray(records) || records.length < 1 || records.length > 500) {
    throw new Error("A page batch must contain between 1 and 500 records.");
  }
  const filters = batch.listing && typeof batch.listing === "object" ? batch.listing : null;
  const key = listingKeyOf(filters);
  // Validate every row before any state changes, so a rejected batch leaves no trace.
  // Rows whose link is not an order PDF (a stray link in the table) are
  // skipped and reported; a page with no valid order link is refused.
  const skipped = [];
  const normalized = records.flatMap((record) => {
    try {
      return [validateRecord(record, portalPage, key)];
    } catch (error) {
      if (error instanceof LinkError) {
        skipped.push(error.message);
        return [];
      }
      throw error;
    }
  });
  if (!normalized.length) {
    throw new Error(`No official order links on this page (${skipped[0] ?? "no rows"}).`);
  }
  if (skipped.length) console.warn(`Page ${portalPage}: skipped ${skipped.length} row(s): ${skipped.slice(0, 3).join("; ")}`);
  // A page whose rows came without subject and date was read by an outdated
  // bookmark (it picked the wrong header row); storing it would lose the
  // order details, so it is refused.
  if (normalized.filter(isThin).length > normalized.length / 2) {
    throw new Error("The order details (subject, date, GO number) were not read from this page. The bookmark is out of date: open this helper page, delete the old bookmark and drag the new one to the bookmarks bar.");
  }
  const listing = listingFor(key, filters);
  const pageSize = Number.parseInt(String(batch.pageSize ?? ""), 10);
  // Changing "records per page" renumbers every page, so page tracking for
  // this listing starts again (orders already saved stay saved).
  if (Number.isInteger(pageSize) && pageSize > 0 && listing.pageSize && listing.pageSize !== pageSize && listing.pages.size) {
    listing.pages.clear();
    listing.rows = 0;
    await appendFile(PAGES_PATH, `${JSON.stringify({ listing: key, filters, resetPages: true, pageSize, capturedAt: new Date().toISOString() })}\n`, "utf8");
  }
  if (Number.isInteger(pageSize) && pageSize > 0) listing.pageSize = pageSize;
  else listing.pageSize ??= records.length;
  listing.reportedTotal = reportedTotal;

  // Orders first saved without row details get a fuller inventory line; the
  // importer merges it and updates the stored metadata.
  const improved = normalized.filter((record) => thinIds.has(record.sourceId) && !isThin(record));
  if (improved.length) {
    for (const record of improved) thinIds.delete(record.sourceId);
    await appendFile(INVENTORY_PATH, `${improved.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  }
  const detailNote = improved.length ? ` Details filled in for ${improved.length} orders saved earlier.` : "";

  const pageDigest = createHash("sha256").update(normalized.map((record) => record.sourceId).join("\n")).digest("hex");

  if (listing.pages.has(portalPage)) {
    if (listing.pages.get(portalPage) === pageDigest) {
      await appendFile(PAGES_PATH, `${JSON.stringify({ listing: key, filters, portalPage, detailsOnly: true, reportedTotal, detailsUpdated: improved.length, capturedAt: new Date().toISOString() })}\n`, "utf8");
      return `Page ${portalPage} of "${key}" was already saved; no new orders.${detailNote}`;
    }
    // The portal served different orders for the same page number. Keep any
    // new orders, but do not count the page twice.
    const fresh = normalized.filter((record) => !seenIds.has(record.sourceId));
    for (const record of fresh) seenIds.add(record.sourceId);
    if (fresh.length) await appendFile(INVENTORY_PATH, `${fresh.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    listing.reshuffles += 1;
    listing.uniqueAdded += fresh.length;
    await appendFile(PAGES_PATH, `${JSON.stringify({ listing: key, filters, portalPage, reshuffle: true, rowsOnPage: normalized.length, pageDigest, uniqueAdded: fresh.length, capturedAt: new Date().toISOString() })}\n`, "utf8");
    return `Page ${portalPage} of "${key}" came back with different orders (the portal reshuffled its list); ${fresh.length} new orders kept.${detailNote}`;
  }

  const lines = [];
  for (const record of normalized) {
    if (seenIds.has(record.sourceId)) continue;
    seenIds.add(record.sourceId);
    lines.push(JSON.stringify(record));
  }
  if (lines.length) await appendFile(INVENTORY_PATH, `${lines.join("\n")}\n`, "utf8");
  await appendFile(PAGES_PATH, `${JSON.stringify({
    listing: key,
    filters,
    portalPage,
    reportedTotal,
    pageSize: listing.pageSize,
    rowsOnPage: normalized.length,
    pageDigest,
    uniqueAdded: lines.length,
    firstSourceId: normalized[0]?.sourceId ?? null,
    lastSourceId: normalized.at(-1)?.sourceId ?? null,
    capturedAt: new Date().toISOString(),
  })}\n`, "utf8");
  listing.pages.set(portalPage, pageDigest);
  listing.rows += normalized.length;
  listing.uniqueAdded += lines.length;
  const expected = expectedPages(listing);
  return `"${key}" page ${portalPage}${expected ? ` of ${expected}` : ""}: ${normalized.length} rows, ${lines.length} new orders.${detailNote} Total unique orders: ${seenIds.size}.`;
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(body);
}

// The bookmark calls the bridge from the portal's page: allow exactly that
// origin, including Chrome's Private/Local Network Access preflight.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": PORTAL_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-bridge-token",
  "Access-Control-Allow-Private-Network": "true",
  "Vary": "Origin",
};

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS_HEADERS });
  response.end(JSON.stringify(body));
}

function validToken(value) {
  if (typeof value !== "string" || value.length !== formToken.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(formToken));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  try {
    if (request.method === "OPTIONS" && url.pathname === "/api/batch") {
      response.writeHead(204, CORS_HEADERS);
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/batch") {
      if (!validToken(request.headers["x-bridge-token"])) {
        sendJson(response, 403, { ok: false, message: "Bridge token is invalid: re-drag the bookmark from the bridge page (the token was reset)." });
        return;
      }
      const batch = JSON.parse(await readBody(request));
      // "seen": this page number was already captured for this listing, so the
      // bookmark can move past it quickly when a run resumes from page 1.
      const known = listings.get(listingKeyOf(batch?.listing && typeof batch.listing === "object" ? batch.listing : null));
      const seen = Boolean(known?.pages.has(Number.parseInt(String(batch?.portalPage ?? ""), 10)) &&
        known.pageSize === Number.parseInt(String(batch?.pageSize ?? ""), 10));
      const message = await acceptBatch(batch);
      sendJson(response, 200, { ok: true, message, seen });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/status")) {
      send(response, 200, page());
      return;
    }
    if (request.method === "POST" && url.pathname === "/batch") {
      const form = new URLSearchParams(await readBody(request));
      if (!validToken(form.get("token"))) throw new Error("The local bridge form token is invalid. Reload the bridge page.");
      send(response, 200, page(await acceptBatch(JSON.parse(form.get("batch") ?? ""))));
      return;
    }
    if (request.method === "POST" && url.pathname === "/complete") {
      const form = new URLSearchParams(await readBody(request));
      if (!validToken(form.get("token"))) throw new Error("The local bridge form token is invalid. Reload the bridge page.");
      const key = form.get("listing") ?? LEGACY_LISTING;
      const listing = listings.get(key);
      if (!listing) throw new Error(`Unknown listing "${key}".`);
      const missing = missingPages(listing) ?? [];
      if (!listing.reportedTotal || missing.length || listing.rows < listing.reportedTotal) {
        send(response, 409, page(`Cannot mark "${key}" complete yet: ${listing.rows} rows over ${listing.pages.size} pages, portal total ${listing.reportedTotal ?? "unknown"}. Missing pages: ${missing.slice(0, 12).join(", ") || "none"}.`));
        return;
      }
      completeMarker.listings[key] = {
        expectedRecords: listing.reportedTotal,
        capturedRows: listing.rows,
        capturedPages: listing.pages.size,
        uniqueAdded: listing.uniqueAdded,
        reshuffledPages: listing.reshuffles,
        completedAt: new Date().toISOString(),
      };
      await writeFile(COMPLETE_PATH, `${JSON.stringify(completeMarker, null, 2)}\n`, "utf8");
      send(response, 200, page(`"${key}" marked complete (${listing.uniqueAdded} new orders). Run npm run portal:report to reconcile.`));
      return;
    }
    if (request.method === "POST" && url.pathname === "/state") {
      const form = new URLSearchParams(await readBody(request));
      if (!validToken(form.get("token"))) throw new Error("The local bridge form token is invalid. Reload the bridge page.");
      const state = JSON.parse(form.get("state") ?? "");
      const pageUrl = new URL(state.url);
      if (pageUrl.origin !== PORTAL_ORIGIN || !Array.isArray(state.fields)) {
        throw new Error("Paging state must come from the official Shasanadesh results page.");
      }
      const fields = {};
      for (const item of state.fields) {
        if (!item || typeof item.name !== "string" || typeof item.value !== "string") continue;
        if (/cookie|password|captcha|CodeNumberTextBox/i.test(item.name)) continue;
        if (item.name.startsWith("__") || ["ddldept", "ddlsection", "ddlcat", "ddlNoRec", "txtGOdate", "txtGOdate0", "txtGOid", "txtSubj"].includes(item.name)) {
          fields[item.name] = item.value;
        }
      }
      if (!fields.__VIEWSTATE || !state.nextTarget?.startsWith("ItemDataPager$")) {
        throw new Error("Paging state is missing the ASP.NET viewstate or next-page target.");
      }
      await writeFile(PAGING_STATE_PATH, `${JSON.stringify({ url: pageUrl.href, pageNumber: state.pageNumber, reportedTotal: state.reportedTotal, fields, nextTarget: state.nextTarget, savedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
      send(response, 200, page(`Saved non-cookie paging state from results page ${state.pageNumber ?? "?"}. CAPTCHA text and browser cookies are excluded.`));
      return;
    }
    send(response, 404, page("Not found."));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (url.pathname === "/api/batch") sendJson(response, 400, { ok: false, message });
    else send(response, 400, page(message));
  }
});

await loadState();
server.listen(PORT, HOST, () => {
  console.log(`Shasanadesh portal bridge listening on http://${HOST}:${PORT}`);
  console.log(`Inventory: ${INVENTORY_PATH}`);
  console.log("Capture bookmark: same as the last run (token in data/portal-capture/.bridge-token). Open the bridge page to copy it again if needed.");
  console.log(`Existing unique orders: ${seenIds.size}; listings: ${[...listings.keys()].join(", ") || "none"}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
