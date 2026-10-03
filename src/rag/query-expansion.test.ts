import assert from "node:assert/strict";
import { acceptCorrection, parseExpansions, parsePlan } from "./query-expansion.js";

assert.deepEqual(
  parseExpansions('{"en":"GFR prior experience similar services qualification criteria","hi":"जीएफआर पूर्व अनुभव समान सेवाएं"}', "service bid experience clause in GFR"),
  ["GFR prior experience similar services qualification criteria", "जीएफआर पूर्व अनुभव समान सेवाएं"],
);
// The question itself, blanks and junk are dropped.
assert.deepEqual(parseExpansions('{"en":"Leave rules","hi":""}', "leave rules"), []);
assert.deepEqual(parseExpansions("not json", "q"), []);
assert.deepEqual(parseExpansions('<think>x</think>{"en":"a b c d","hi":"a b c d"}', "q"), ["a b c d"]);
assert.equal(parseExpansions('{"en":"a b c d","hi":"क ख ग घ","passage":"Contracts may provide an interest-bearing advance."}', "q").length, 3);
// Typo and grammar fixes are kept; drift is not.
assert.equal(acceptCorrection("What is the criteria for moblisation advance in GFR?", "What are the criteria for mobilisation advance in GFR?"), "What are the criteria for mobilisation advance in GFR?");
assert.equal(acceptCorrection("leave rules", "leave rules"), null);
assert.equal(acceptCorrection("GO 51/2026 kya hai", "What does GO 52/2026 say?"), null); // number changed
assert.equal(acceptCorrection("प्रसूति अवकाश नियम", "Maternity leave rules"), null); // language changed
assert.equal(acceptCorrection("leave", "What are all the leave rules, allowances and pension provisions for officers?"), null); // too long
assert.equal(parsePlan('{"corrected":"What are the criteria for mobilisation advance?","en":"GFR mobilisation advance","hi":"मोबिलाइजेशन अग्रिम"}', "What is the criteria for moblisation advance?").corrected, "What are the criteria for mobilisation advance?");
console.log("query expansion tests passed");
