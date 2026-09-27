import assert from "node:assert/strict";
import { parseModelReply } from "./model-pass.js";

assert.deepEqual(parseModelReply('{"tier":"A","docType":"guideline","reason":"statewide procedure"}'), { tier: "A", docType: "guideline", reason: "statewide procedure" });
assert.deepEqual(parseModelReply('<think>hmm</think>\nSure: {"tier":"c","docType":"sanction","reason":"fund release"}'), { tier: "C", docType: "sanction", reason: "fund release" });
assert.equal(parseModelReply('{"tier":"D","docType":"guideline"}'), null);
assert.equal(parseModelReply('{"tier":"A","docType":"memo"}'), null);
assert.equal(parseModelReply("not json"), null);
console.log("model classification parser tests passed");
