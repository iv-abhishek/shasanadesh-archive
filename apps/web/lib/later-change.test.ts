import assert from "node:assert/strict";
import { describeLaterChange, officialShasanadeshUrl, readLaterChanges } from "./sources";

// Official link: base64 of the ID in id1, only for Shasanadesh-shaped IDs.
assert.equal(
  officialShasanadeshUrl("89#187#10#2026"),
  `https://shasanadesh.up.gov.in/GO/ViewGOPDF_list_user.aspx?id1=${encodeURIComponent(Buffer.from("89#187#10#2026").toString("base64"))}`,
);
assert.equal(officialShasanadeshUrl("investup:abc"), null);

// Card text in both languages; missing number or date degrades gracefully.
const change = { kind: "amends" as const, bySourceId: "89#187#10#2026", byGoNumber: "89/2026/1472", byGoDate: "2026-08-19" };
assert.equal(describeLaterChange(change, "en"), "Amended by GO 89/2026/1472 dated 19 Aug 2026");
assert.equal(describeLaterChange(change, "hi"), "संशोधित — शासनादेश संख्या 89/2026/1472, दिनांक 19 Aug 2026");
assert.equal(describeLaterChange({ ...change, kind: "cancels", byGoNumber: null, byGoDate: null }, "en"), "Cancelled by a later order");

// Stream / saved-message input is filtered to well-formed entries.
assert.deepEqual(
  readLaterChanges([change, { kind: "refers", bySourceId: "x" }, { kind: "toString", bySourceId: "y" }, { kind: "amends" }, null]),
  [change],
);
assert.deepEqual(readLaterChanges(undefined), []);

console.log("later-change display tests passed");
