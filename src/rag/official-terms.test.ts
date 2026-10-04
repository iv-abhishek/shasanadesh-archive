import assert from "node:assert/strict";
import { officialTermsFor, withOfficialTerms } from "./official-terms.js";

assert.deepEqual(officialTermsFor("maximum earned leave that can be accumulated"), ["उपार्जित अवकाश"]);
assert.deepEqual(officialTermsFor("उपार्जित अवकाश की अधिकतम सीमा"), ["earned leave"]);
assert.deepEqual(officialTermsFor("अर्जित छुट्टी कितनी जमा हो सकती है"), ["earned leave", "उपार्जित अवकाश"]);
assert.deepEqual(officialTermsFor("earned leave उपार्जित अवकाश"), []);
assert.deepEqual(officialTermsFor("EMD for GeM bids"), ["बयाना राशि"]);
assert.deepEqual(officialTermsFor("system remd value"), [], "whole words only");
assert.equal(withOfficialTerms("pension rules"), "pension rules");
assert.ok(officialTermsFor("maternity leave, child care leave, earned leave, casual leave and medical leave").length <= 4);
console.log("official terms tests passed");
