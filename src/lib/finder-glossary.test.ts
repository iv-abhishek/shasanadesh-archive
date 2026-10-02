import assert from "node:assert/strict";
import { patternVariants, termVariants } from "./finder-glossary.js";

assert.ok(termVariants("Solar").includes("सोलर"));
assert.ok(termVariants("पंप").includes("पम्प"));
assert.deepEqual(termVariants("कुम्भ"), ["कुम्भ"]);
assert.deepEqual(patternVariants("*solar पम्प*").slice(0, 3), ["*solar पम्प*", "*सोलर पम्प*", "*सौर पम्प*"]);
console.log("finder glossary tests passed");
