import assert from "node:assert/strict";
import { parseModelReply } from "./model-pass.js";

assert.deepEqual(parseModelReply('{"tier":"A","docType":"guideline","reason":"statewide procedure"}'), { tier: "A", docType: "guideline", reason: "statewide procedure" });
assert.deepEqual(parseModelReply('<think>hmm</think>\nSure: {"tier":"c","docType":"sanction","reason":"fund release"}'), { tier: "C", docType: "sanction", reason: "fund release" });
assert.equal(parseModelReply('{"tier":"D","docType":"guideline"}'), null);
// Types in the model's own words keep the tier (3 Oct: 69% were discarded).
assert.equal(parseModelReply('{"tier":"A","docType":"memo"}')?.docType, "other");
assert.equal(parseModelReply('{ "tier": "A", "docType": "rule amendment", "reason": "x" }')?.docType, "rules");
assert.equal(parseModelReply('{ "tier": "A", "docType": "rule", "reason": "x" }')?.docType, "rules");
assert.equal(parseModelReply('{ "tier": "A", "docType": "Rule-Amendment" }')?.tier, "A");
assert.equal(parseModelReply('{ "tier": "C", "docType": "Office Memorandum" }')?.docType, "general-instruction");
assert.equal(parseModelReply("not json"), null);
console.log("model classification parser tests passed");
