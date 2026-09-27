#!/usr/bin/env node
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
const formToken = randomBytes(24).toString("hex");

const seenIds = new Set();
let reportedTotal = null;
let pageCount = 0;
let capturedRows = 0;
let isComplete = false;
const capturedPages = new Map();

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function page(message = "") {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Shasanadesh portal inventory bridge</title>
<style>
body{font:16px system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#18212b}
textarea{width:100%;height:18rem;font:13px ui-monospace,monospace} input{font:inherit;padding:.4rem}
button{font:inherit;padding:.55rem 1rem;margin:.75rem .5rem .75rem 0} .status{padding:.8rem;background:#edf6ee;white-space:pre-wrap}
</style>
<h1>Shasanadesh portal inventory bridge</h1>
<p>Loopback only: this page accepts result metadata from the authenticated Shasanadesh tab and appends it to the local inventory.</p>
<p id="status">Unique orders saved: <strong>${seenIds.size}</strong> · Result rows captured: <strong>${capturedRows}</strong> · Pages captured: <strong>${pageCount}</strong> · Portal total: <strong>${reportedTotal ?? "not received"}</strong> · ${isComplete ? "Listing marked complete" : "Listing still open"}</p>
${message ? `<p class="status">${htmlEscape(message)}</p>` : ""}
<form method="post" action="/batch">
  <input type="hidden" name="token" value="${formToken}">
  <label>Result page<input name="portalPage" value="" inputmode="numeric" required></label>
  <label> Portal total<input name="reportedTotal" value="${reportedTotal ?? 177501}" inputmode="numeric" required></label>
  <p>Paste the extracted JSON batch:</p>
  <textarea name="batch" required spellcheck="false" autocomplete="off"></textarea>
  <p><button type="submit">Append this page</button></p>
</form>
<form method="post" action="/complete"><input type="hidden" name="token" value="${formToken}"><button type="submit">Mark listing complete</button></form>
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

function validateRecord(record, portalPage) {
  if (!record || typeof record !== "object") throw new Error("Batch contains a non-object record.");
  const sourceUrl = new URL(record.sourceUrl);
  if (sourceUrl.origin !== PORTAL_ORIGIN || sourceUrl.pathname !== "/GO/ViewGOPDF_list_user.aspx") {
    throw new Error("A record link did not point to the official Shasanadesh PDF endpoint.");
  }
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
    clean[key] = typeof value === "string" ? value.trim() : null;
  }
  return {
    sourceId,
    encodedId,
    sourceUrl: sourceUrl.href,
    portalPage,
    portalRow: Number.isInteger(record.portalRow) ? record.portalRow : null,
    capturedAt: new Date().toISOString(),
    ...clean,
  };
}

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  for (const line of (await readFile(INVENTORY_PATH, "utf8").catch(() => "")).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { seenIds.add(JSON.parse(line).sourceId); } catch { /* worker reports malformed inventory */ }
  }
  const pages = (await readFile(PAGES_PATH, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean);
  for (const line of pages) {
    try {
      const entry = JSON.parse(line);
      const digest = entry.pageDigest;
      capturedPages.set(entry.portalPage, digest);
      capturedRows += Number(entry.rowsOnPage) || 0;
    } catch { /* malformed ledger lines are not counted */ }
  }
  pageCount = capturedPages.size;
  const lastPage = pages.at(-1);
  if (lastPage) {
    try { reportedTotal = JSON.parse(lastPage).reportedTotal ?? null; } catch { /* retain default */ }
  }
  try { isComplete = Boolean(JSON.parse(await readFile(COMPLETE_PATH, "utf8")).completedAt); }
  catch { isComplete = false; }
}

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(body);
}

function validToken(value) {
  if (typeof value !== "string" || value.length !== formToken.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(formToken));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/status")) {
      send(response, 200, page());
      return;
    }
    if (request.method === "POST" && url.pathname === "/batch") {
      const form = new URLSearchParams(await readBody(request));
      if (!validToken(form.get("token"))) throw new Error("The local bridge form token is invalid. Reload the bridge page.");
      const portalPage = Number.parseInt(form.get("portalPage") ?? "", 10);
      const submittedTotal = Number.parseInt(form.get("reportedTotal") ?? "", 10);
      if (!Number.isInteger(portalPage) || portalPage < 1 || !Number.isInteger(submittedTotal) || submittedTotal < 1) {
        throw new Error("Page number and portal total must be positive integers.");
      }
      const parsed = JSON.parse(form.get("batch") ?? "");
      const records = Array.isArray(parsed) ? parsed : parsed.records;
      if (!Array.isArray(records) || records.length < 1 || records.length > 100) {
        throw new Error("A page batch must contain between 1 and 100 records.");
      }
      const normalized = records.map((record) => validateRecord(record, portalPage));
      const pageDigest = createHash("sha256").update(normalized.map((record) => record.sourceId).join("\n")).digest("hex");
      if (capturedPages.has(portalPage)) {
        if (capturedPages.get(portalPage) !== pageDigest) {
          throw new Error(`Portal page ${portalPage} was already captured with different order IDs; restart the inventory from a consistent result set.`);
        }
        send(response, 200, page(`Page ${portalPage} was already saved; no duplicate page was added.`));
        return;
      }
      let added = 0;
      const lines = [];
      for (const record of normalized) {
        if (seenIds.has(record.sourceId)) continue;
        seenIds.add(record.sourceId);
        lines.push(JSON.stringify(record));
        added++;
      }
      if (lines.length) await appendFile(INVENTORY_PATH, `${lines.join("\n")}\n`, "utf8");
      const ledger = {
        portalPage,
        reportedTotal: submittedTotal,
        rowsOnPage: normalized.length,
        pageDigest,
        uniqueAdded: added,
        firstSourceId: normalized[0]?.sourceId ?? null,
        lastSourceId: normalized.at(-1)?.sourceId ?? null,
        capturedAt: new Date().toISOString(),
      };
      await appendFile(PAGES_PATH, `${JSON.stringify(ledger)}\n`, "utf8");
      capturedPages.set(portalPage, pageDigest);
      pageCount++;
      capturedRows += normalized.length;
      reportedTotal = submittedTotal;
      send(response, 200, page(`Page ${portalPage}: accepted ${normalized.length} rows, added ${added} new orders. Total unique orders saved: ${seenIds.size}.`));
      return;
    }
    if (request.method === "POST" && url.pathname === "/complete") {
      const form = new URLSearchParams(await readBody(request));
      if (!validToken(form.get("token"))) throw new Error("The local bridge form token is invalid. Reload the bridge page.");
      const expectedRecords = reportedTotal;
      const expectedPages = expectedRecords ? Math.ceil(expectedRecords / 100) : 0;
      const missingPages = Array.from({ length: expectedPages }, (_, index) => index + 1).filter((number) => !capturedPages.has(number));
      if (!expectedRecords || capturedRows < expectedRecords || missingPages.length) {
        send(response, 409, page(`Cannot mark complete yet. ${capturedRows} result rows captured across ${pageCount} pages; portal total is ${expectedRecords ?? "unknown"}. Missing pages: ${missingPages.slice(0, 12).join(", ") || "none"}.`));
        return;
      }
      const marker = { expectedRecords, capturedRows, capturedPages: pageCount, uniqueRecords: seenIds.size, completedAt: new Date().toISOString() };
      await writeFile(COMPLETE_PATH, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
      isComplete = true;
      send(response, 200, page(`Listing marked complete with ${seenIds.size} unique orders.`));
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
    send(response, 400, page(error instanceof Error ? error.message : String(error)));
  }
});

await loadState();
server.listen(PORT, HOST, () => {
  console.log(`Shasanadesh portal bridge listening on http://${HOST}:${PORT}`);
  console.log(`Inventory: ${INVENTORY_PATH}`);
  console.log(`Existing unique orders: ${seenIds.size}; pages: ${pageCount}; reported total: ${reportedTotal ?? "not set"}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
