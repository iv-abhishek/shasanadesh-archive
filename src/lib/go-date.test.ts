import assert from "node:assert/strict";
import { toIsoGoDate } from "./go-date.js";

assert.equal(toIsoGoDate("2023-09-15"), "2023-09-15");
assert.equal(toIsoGoDate("26/09/2026"), "2026-09-26"); // portal listing, day first
assert.equal(toIsoGoDate("5/1/2024"), "2024-01-05");
assert.equal(toIsoGoDate("05-01-2024"), "2024-01-05");
assert.equal(toIsoGoDate("31/02/2024"), null); // impossible date
assert.equal(toIsoGoDate("2024/01/05"), null); // ambiguous shape: not guessed
assert.equal(toIsoGoDate(""), null);
assert.equal(toIsoGoDate(null), null);

console.log("go-date tests passed");
