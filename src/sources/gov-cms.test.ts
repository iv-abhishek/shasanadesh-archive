import assert from "node:assert/strict";
import { isoDate, loadSites } from "./gov-cms.js";
import { isGovernmentHost, isGovernmentUrl } from "../lib/government-hosts.js";

assert.equal(isoDate("21/09/2026"), "2026-09-21");
assert.equal(isoDate("2026-09-21"), null);
// ".सरकार.भारत" (Hindi-script .gov.in) is a government suffix; URL parsing gives punycode.
assert.equal(isGovernmentUrl("https://सूक्ष्मलघुऔरमध्यमउद्यममंत्रालय.सरकार.भारत/archives"), true);
assert.equal(isGovernmentHost("xn--11b7cb3a6a.xn--h2brj9c"), false); // the bare suffix is not a site
assert.equal(isGovernmentUrl("https://example.भारत/"), false);
const sites = loadSites();
assert.ok(sites.some((site) => site.id === "msme"));
console.log("gov-cms tests passed");
