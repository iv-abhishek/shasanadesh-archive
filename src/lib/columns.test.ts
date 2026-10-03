import assert from "node:assert/strict";
import { decolumn, findGutter } from "./columns.js";

const twoColumn = [
  "Rule 172 (1) Advance payment to supplier                  Rule 172 (2) Part payment to suppliers:",
  "     Ordinarily, payments for services                          Depending on the terms of delivery",
  "     rendered or supplies made should be                        incorporated in a contract, part",
  "     released only after the services have                      payment to the supplier may be",
  "     been rendered or supplies made.                            released after it dispatches the goods",
  "     However, it may become necessary                           from its premises in terms of the",
  "     to make advance payments for                               contract.",
  "     example in the following types of                    Rule 173 Transparency, competition,",
  "     cases:                                                     fairness and elimination of",
  "     (i) Advance payment demanded                               arbitrariness in the procurement",
].join("\n");
assert.ok(findGutter(twoColumn));
const out = decolumn(twoColumn);
// The left column reads through before the right one starts.
assert.ok(out.indexOf("supplies made.") < out.indexOf("Part payment to suppliers"));
assert.ok(out.indexOf("Advance payment demanded") < out.indexOf("Depending on the terms"));

const oneColumn = Array.from({ length: 12 }, (_, i) => `    This is an ordinary single column line number ${i} of a government order letter text.`).join("\n");
assert.equal(findGutter(oneColumn), null);
assert.equal(decolumn(oneColumn), oneColumn);
// A three-column table keeps its rows.
const table = Array.from({ length: 10 }, (_, i) => `${String(i + 1).padEnd(4)}Item description number ${i}        Head of Department          Up to Rs ${i + 1} lakh a year`).join("\n");
assert.equal(findGutter(table), null);
console.log("two-column tests passed");
