import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isGovernmentHost, isGovernmentUrl } from "./government-hosts.js";
import { officialOnly, stripNonGovernmentLinks } from "./public-links.js";

// Government hosts (Rulebook §2).
for (const host of ["shasanadesh.up.gov.in", "doe.gov.in", "cdn.s3waas.gov.in", "budget.up.nic.in", "rajasthan.gov.in", "cert-in.org.in"]) {
  assert.ok(isGovernmentHost(host), host);
}
for (const host of ["staffnews.in", "www.scribd.com", "upgovtorders.com", "gov.in.example.com", "fakegov.in", "nic.in.evil.com", "localhost"]) {
  assert.ok(!isGovernmentHost(host), host);
}
assert.ok(!isGovernmentHost(".gov.in"));
assert.ok(isGovernmentUrl("https://doe.gov.in/files/x.pdf"));
assert.ok(!isGovernmentUrl("/api/rag/pdf?sourceId=1"));
assert.ok(!isGovernmentUrl("javascript:alert(1)"));

// Chat links (Rulebook §1).
assert.equal(officialOnly("https://shasanadesh.up.gov.in/GO/ViewGOPDF_list_user.aspx?id1=MQ==#page=2"), "https://shasanadesh.up.gov.in/GO/ViewGOPDF_list_user.aspx?id1=MQ==#page=2");
assert.equal(officialOnly("http://localhost:3000/api/rag/pdf?sourceId=1"), null);
assert.equal(officialOnly(null), null);
assert.equal(
  stripNonGovernmentLinks("See https://doe.gov.in/x.pdf and https://www.staffnews.in/y.html [S1 p.2]."),
  "See https://doe.gov.in/x.pdf and [S1 p.2].",
);
assert.equal(stripNonGovernmentLinks("Open /api/rag/pdf?sourceId=5#page=2 now"), "Open now");
assert.equal(stripNonGovernmentLinks("file data/documents/82-25-4-2026/original.pdf"), "file ");
assert.equal(stripNonGovernmentLinks("key archive/core-rules/raw/x/y.pdf here"), "key here");
assert.equal(stripNonGovernmentLinks("शासनादेश संख्या 51/2026 [S1 p.1]"), "शासनादेश संख्या 51/2026 [S1 p.1]");

// The browser copy of the host policy must match the server's.
const server = readFileSync(path.join(__dirname, "government-hosts.ts"), "utf8");
const browser = readFileSync(path.join(__dirname, "../../apps/web/lib/government-hosts.ts"), "utf8");
const body = (text: string) => text.slice(text.indexOf("export const GOVERNMENT_SUFFIXES"));
assert.equal(body(browser), body(server));

console.log("public link rules tests passed");
