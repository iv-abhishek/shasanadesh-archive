import assert from "node:assert/strict";
import { parseExpansions } from "./query-expansion.js";

assert.deepEqual(
  parseExpansions('{"en":"GFR prior experience similar services qualification criteria","hi":"जीएफआर पूर्व अनुभव समान सेवाएं"}', "service bid experience clause in GFR"),
  ["GFR prior experience similar services qualification criteria", "जीएफआर पूर्व अनुभव समान सेवाएं"],
);
// The question itself, blanks and junk are dropped.
assert.deepEqual(parseExpansions('{"en":"Leave rules","hi":""}', "leave rules"), []);
assert.deepEqual(parseExpansions("not json", "q"), []);
assert.deepEqual(parseExpansions('<think>x</think>{"en":"a b c d","hi":"a b c d"}', "q"), ["a b c d"]);
console.log("query expansion tests passed");
