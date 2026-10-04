/** Official-website search (ADR-096): filtering and evidence shape; no network. */
import assert from "node:assert/strict";
import { acceptResults, isOtherStateHost, isUpHost, webEvidence } from "./web-search.js";

assert.ok(isOtherStateHost("dpar.karnataka.gov.in"));
assert.ok(isOtherStateHost("csharyana.gov.in"));
assert.ok(!isOtherStateHost("budget.up.nic.in"));
assert.ok(!isOtherStateHost("doe.gov.in"));
assert.ok(isUpHost("budget.up.nic.in"));
assert.ok(isUpHost("invest.up.gov.in"));
assert.ok(isUpHost("upsdc.gov.in"));
assert.ok(!isUpHost("dopt.gov.in"));

const long = "rule text ".repeat(40);
const accepted = acceptResults([
  { url: "https://budget.up.nic.in/Fin_H_Book/volume2/36.html", title: "FHB", raw_content: long, score: 0.8 },
  { url: "https://dpar.karnataka.gov.in/leave", title: "Karnataka", raw_content: long, score: 0.9 },
  { url: "https://example.com/blog", title: "Blog", raw_content: long, score: 0.9 },
  { url: "https://doe.gov.in/om.pdf", title: "DoE OM", raw_content: long, score: 0.2 },
  { url: "https://doe.gov.in/short", title: "Short", raw_content: "too short", score: 0.9 },
  { url: "https://budget.up.nic.in/Fin_H_Book/volume2/36.html", title: "dup", raw_content: long, score: 0.8 },
]);
assert.deepEqual(accepted.map((r) => r.url), ["https://budget.up.nic.in/Fin_H_Book/volume2/36.html"]);
assert.equal(accepted[0].up, true);

const [page] = webEvidence(accepted, 3);
assert.equal(page.label, "S4");
assert.equal(page.page_number, 1);
assert.match(page.source_id, /^web-[0-9a-f]{12}$/);
assert.match(page.document_title ?? "", /Uttar Pradesh government website/);
assert.equal(page.provider, "web-official");
assert.equal(page.source_url, accepted[0].url);
console.log("official web search tests passed");
