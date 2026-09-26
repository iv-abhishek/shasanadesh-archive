import assert from "node:assert/strict";
import { formatGoReference, formatReferenceDate } from "./go-reference";

const go = { sourceId: "61#37#5#2023", goNumber: "61/2023/37-5", goDate: "2023-09-15", department: "Agriculture" };

assert.equal(formatGoReference(go, "hi"), "शासनादेश संख्या 61/2023/37-5, दिनांक 15.09.2023");
assert.equal(formatGoReference(go, "en"), "G.O. No. 61/2023/37-5, dated 15.09.2023");

// Portal dates are day-first; zero-width joiners are removed.
assert.equal(
  formatGoReference({ ...go, goNumber: "118/2026/‍71-1002", goDate: "26/09/2026" }, "hi"),
  "शासनादेश संख्या 118/2026/71-1002, दिनांक 26.09.2026",
);

// No GO number recorded: fall back to the title, never invent a number.
assert.equal(
  formatGoReference({ sourceId: "doe-gfr-518f", goNumber: null, goDate: "2026-05-05", documentTitle: "Guidelines for transfer of land" }, "en"),
  "Guidelines for transfer of land, dated 05.05.2026",
);
assert.equal(formatGoReference({ ...go, goNumber: null, goDate: null }, "hi"), "शासनादेश (Agriculture)");

assert.equal(formatReferenceDate("5/1/2024"), "05.01.2024");
assert.equal(formatReferenceDate("Sept 2024"), "Sept 2024");

console.log("GO reference tests passed");
