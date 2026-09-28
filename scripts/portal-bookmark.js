/*
 * Shasanadesh capture bookmark (served by scripts/shasanadesh-portal-bridge.mjs,
 * which fills in __BRIDGE__ and __TOKEN__). Runs in the portal tab after a
 * person has searched and completed the CAPTCHA. Reads the results table and
 * sends it to the bridge; then, if asked, follows the portal's own "Next" link
 * page after page in the same browser session (the pager needs no CAPTCHA),
 * one page every few seconds, until the last page or until stopped.
 * Keep comments in this block style: the file becomes a javascript: URL.
 */
(async () => {
const BRIDGE = "__BRIDGE__", TOKEN = "__TOKEN__", PAGE_DELAY_MS = 4000;
const HOST_OK = (h) => /^shasanadesh\.up\.(gov|nic)\.in$/.test(h.toLowerCase().replace(/^www\./, ""));
if (!HOST_OK(location.hostname)) {
  alert("Shasanadesh bridge: this tab is " + (location.hostname || location.href.slice(0, 60)) + ". Click the bookmark on the Shasanadesh results tab (shasanadesh.up.gov.in) after the search has shown the list of orders.");
  return;
}
if (window.__sdCapture) { alert("Shasanadesh bridge: capture is already running in this tab."); return; }
const HEAD = { department: /विभाग|Department/i, section: /अनुभाग|Section/i, goNumber: /संख्या|G\.?\s*O\.?\s*No|Number/i, goDate: /तिथि|दिनांक|Date/i, category: /श्रेणी|Category/i, subject: /विषय|Subject/i };
const DATE = /^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Text with <br> as line breaks; works in parsed (unrendered) documents too. */
const lines = (el) => { const c = el.cloneNode(true); c.querySelectorAll("br").forEach((b) => b.replaceWith("\n")); return c.textContent.split(/\n+/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean); };
const flat = (el) => lines(el).join(" ");
const isOrderLink = (a, base) => { try { const u = new URL(a.getAttribute("href"), base); return HOST_OK(u.hostname) && /\/go\/viewgopdf_list_user\.aspx$/i.test(u.pathname); } catch (_) { return false; } };

function readPage(doc, base) {
  const docs = [doc, ...[...doc.querySelectorAll("iframe,frame")].map((f) => { try { return f.contentDocument; } catch (_) { return null; } }).filter(Boolean)];
  const links = docs.flatMap((d) => [...d.querySelectorAll("a[href]")]).filter((a) => isOrderLink(a, base));
  if (!links.length) return { error: "no order links on this page" };
  const table = links[0].closest("table"), linkRow = links[0].closest("tr"), width = linkRow ? linkRow.children.length : 0;
  let headers = [], best = 0;
  if (table) for (const r of table.querySelectorAll("tr")) {
    if (r.contains(links[0]) || r.querySelector("table")) continue;
    const cells = [...r.children];
    if (width && cells.length !== width) continue;
    const t = cells.map(flat);
    const score = Object.values(HEAD).filter((re) => t.some((x) => re.test(x))).length;
    if (score > best) { best = score; headers = t; }
  }
  let idx = {};
  if (best >= 2) { for (const k in HEAD) idx[k] = headers.findIndex((t) => HEAD[k].test(t)); }
  else if (width === 7) idx = { department: 1, section: 1, goNumber: 2, goDate: 3, category: 4, subject: 5 };
  const shared = idx.department >= 0 && idx.department === idx.section;
  const text = (cells, k) => {
    const i = idx[k];
    if (!(i >= 0) || !cells[i]) return null;
    const l = lines(cells[i]);
    if (shared && k === "department") return l[0] || null;
    if (shared && k === "section") return l.slice(1).join(" ") || null;
    return l.join(" ") || null;
  };
  const records = links.map((a, i) => {
    const row = a.closest("tr"), cells = row ? [...row.children] : [];
    return { sourceUrl: new URL(a.getAttribute("href"), base).href, department: text(cells, "department"), section: text(cells, "section"), goNumber: text(cells, "goNumber"), goDate: text(cells, "goDate"), category: text(cells, "category"), subject: text(cells, "subject"), linkText: flat(a) || null, portalRow: i + 1 };
  });
  const readable = records.filter((r) => r.subject && DATE.test(r.goDate || "")).length;
  if (readable < Math.ceil(records.length / 2)) return { error: "the order details (subject, date) could not be read from this table" };
  const pager = doc.querySelector('[id*="DataPager"],[id*="Pager"]');
  let page = null, next = null;
  if (pager) {
    const cur = [...pager.querySelectorAll("span")].find((s) => /^\d+$/.test(s.textContent.trim()) && !s.closest("a") && !s.querySelector("span"));
    if (cur) page = Number(cur.textContent.trim());
    const n = [...pager.querySelectorAll("a[href]")].find((a) => /^(Next|अगला|>)$/i.test(a.textContent.trim()));
    const m = n && n.getAttribute("href").match(/__doPostBack\('([^']+)'/);
    if (m) next = m[1];
  }
  const bt = doc.body.textContent;
  const tm = bt.match(/कुल\s*प्राप्त\s*अभिलेख\s*[-–:]*\s*([\d,]+)/) || bt.match(/Total\s*(?:Records?|Results?)(?:\s*Found)?\s*[-–:]+\s*([\d,]+)/i);
  const total = tm ? Number(tm[1].replace(/,/g, "")) : null;
  const sel = (n) => { const e = doc.querySelector('select[name$="' + n + '"]'); if (!e) return null; const o = e.querySelector("option[selected]") || e.options[e.selectedIndex]; return o && o.value && e.options[0] !== o ? o.textContent.trim() : null; };
  const val = (n) => { const e = doc.querySelector('input[name$="' + n + '"]'); const v = e && (e.getAttribute("value") ?? e.value); return v && v.trim() ? v.trim() : null; };
  const size = Number(sel("ddlNoRec")) || records.length;
  const listing = { department: sel("ddldept"), section: sel("ddlsection"), category: sel("ddlcat"), dateFrom: val("txtGOdate"), dateTo: val("txtGOdate0"), goNumber: val("txtGOid"), subject: val("txtSubj") };
  return { records, page, next, total, size, listing };
}

async function send(r) {
  const batch = { listing: r.listing, portalPage: r.page, reportedTotal: r.total, pageSize: r.size, records: r.records };
  try {
    const res = await fetch(BRIDGE + "/api/batch", { method: "POST", headers: { "content-type": "application/json", "x-bridge-token": TOKEN }, body: JSON.stringify(batch) });
    const j = await res.json();
    return { ok: res.ok && j.ok !== false, message: j.message };
  } catch (e) {
    try { await navigator.clipboard.writeText(JSON.stringify(batch)); } catch (_) { console.log(JSON.stringify(batch)); }
    return { ok: false, message: "Bridge not reachable (" + e.message + "). Is npm run portal:bridge running? The page was copied: paste it into the bridge form." };
  }
}

/* The portal's own "Next": post the page's form back with the pager as the event target. */
async function postBack(doc, target) {
  const form = doc.querySelector("form#form1") || [...doc.forms].find((f) => f.querySelector('input[name="__VIEWSTATE"]'));
  if (!form) throw new Error("the portal form was not found");
  const body = new URLSearchParams();
  for (const el of form.querySelectorAll("input[name],select[name],textarea[name]")) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (el.disabled || ["submit", "button", "image", "file", "reset"].includes(type)) continue;
    if (/captcha/i.test(el.name)) continue;
    if ((type === "checkbox" || type === "radio") && !(el.checked || el.hasAttribute("checked"))) continue;
    let v;
    if (el.tagName === "SELECT") { const o = el.querySelector("option[selected]") || el.options[el.selectedIndex]; v = o ? o.value : ""; }
    else v = el.tagName === "TEXTAREA" ? el.textContent : (el.getAttribute("value") ?? el.value ?? "");
    body.append(el.name, v);
  }
  body.set("__EVENTTARGET", target);
  body.set("__EVENTARGUMENT", "");
  const action = new URL(form.getAttribute("action") || location.href, location.href).href;
  const res = await fetch(action, { method: "POST", credentials: "include", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error("the portal answered HTTP " + res.status);
  return new DOMParser().parseFromString(await res.text(), "text/html");
}

let r = readPage(document, location.href);
if (r.error) { alert("Shasanadesh bridge: " + r.error + ", so nothing was sent. Run the portal search first; if the list is showing, save this page (Cmd+S) into data/tmp and ask Claude to check it."); return; }
if (!r.page) r.page = Number(prompt("Results page number?", "1"));
if (!r.total) r.total = Number(prompt("Total results shown by the portal?", ""));
let sent = await send(r);
if (!sent.ok || !r.next) { alert("Shasanadesh bridge: " + sent.message); return; }
const pages = r.total && r.size ? Math.ceil(r.total / r.size) : null;
const left = pages ? pages - r.page : null;
if (!confirm("Shasanadesh bridge: " + sent.message + "\n\nCapture the remaining " + (left ?? "") + " pages automatically? About " + (left ? Math.ceil(left * (PAGE_DELAY_MS + 2000) / 60000) + " minutes" : "one page every few seconds") + ". Keep this tab open; the Mac must stay awake.")) return;

window.__sdCapture = true;
const box = document.createElement("div");
box.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#123;color:#fff;padding:12px 14px;border-radius:10px;font:14px/1.4 system-ui;max-width:380px;box-shadow:0 4px 18px rgba(0,0,0,.3)";
const msg = document.createElement("div"), stop = document.createElement("button");
stop.textContent = "Stop"; stop.style.cssText = "margin-top:8px;padding:4px 12px;cursor:pointer";
let stopped = false; stop.onclick = () => { stopped = true; stop.disabled = true; stop.textContent = "Stopping…"; };
box.append(msg, stop); document.body.append(box);
const show = (t) => { msg.textContent = t; document.title = t.slice(0, 60); };

let doc = document, last = r.page, failures = 0, done = 1, end = "";
while (!stopped && r.next) {
  show("Page " + last + (pages ? " of " + pages : "") + " saved. " + sent.message.slice(0, 160));
  await sleep(PAGE_DELAY_MS);
  if (stopped) break;
  let nr;
  try {
    const nd = await postBack(doc, r.next);
    nr = readPage(nd, location.href);
    if (nr.error) throw new Error(nr.error + " (the portal session may have expired)");
    if (!nr.page || nr.page <= last) throw new Error("the portal did not move past page " + last);
    doc = nd;
  } catch (e) {
    if (++failures <= 3) { show("Page " + (last + 1) + ": " + e.message + ". Retrying in 30 s…"); await sleep(30000); continue; }
    end = "Stopped at page " + last + ": " + e.message + ". Search again and use the portal's page links to reach page " + (last + 1) + ", then click the bookmark there.";
    break;
  }
  failures = 0;
  r = nr;
  sent = await send(r);
  if (!sent.ok) { end = "Stopped at page " + r.page + ": " + sent.message; break; }
  last = r.page; done++;
}
window.__sdCapture = false;
if (!end) end = stopped ? "Stopped by you after page " + last + "." : "Finished: last page " + last + " saved.";
show(end + " Pages sent this run: " + done + ".");
stop.remove();
alert("Shasanadesh bridge: " + end);
})();
