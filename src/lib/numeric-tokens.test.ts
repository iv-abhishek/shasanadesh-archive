import assert from "node:assert/strict";
import { numericTokens, toAsciiDigits } from "./numeric-tokens.js";

assert.equal(toAsciiDigits("दिनांक १५.०८.२०२०"), "दिनांक 15.08.2020");

// Devanagari-only numbers are now extracted.
assert.deepEqual(numericTokens("नियम २१ वर्ष २०२०"), ["21", "2020"]);

// Same value in different scripts is not a conflict.
assert.deepEqual(numericTokens("वर्ष २०२०।"), numericTokens("वर्ष 2020।"));

// Different Devanagari values are detected as different.
assert.notDeepEqual(numericTokens("लेवल ११"), numericTokens("लेवल १२"));

// Trailing punctuation is trimmed and duplicates removed.
assert.deepEqual(numericTokens("Rule 5, rule 5."), ["5"]);

console.log("numeric-tokens tests passed");
