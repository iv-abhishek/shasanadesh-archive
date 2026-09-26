import assert from "node:assert/strict";
import { analyzeTextQuality } from "./text-quality.js";

const clean =
  "कृषकों का चयन टोकन प्रक्रिया के आधार पर पहले आओ पहले पाओ के आधार पर किया जायेगा। " +
  "आवेदन के समय कृषक को टोकन मनी के रूप में आनलाइन जमा करना होगा। सोलर पम्प हेतु बुकिंग " +
  "जनपदवार एवं क्षमतावार आवंटित लक्ष्य तक की जायेगी। ";

// The same sentence as a broken legacy-font export: ZWJ instead of spaces,
// U+0904 instead of अ, and dropped letters.
const garbled =
  "कृ षकों‍का‍ियन‍टोकन‍प्रदिया‍के ‍ऄधार‍र‍ हले‍ ऄव- हले‍ ाव‍के ‍ऄधार‍र‍दकया‍जायेगा। " +
  "ऄिेदन‍के ‍ समय‍ कृ षक‍ को‍ टोकन‍ मनी‍ के ‍ रू ‍ में‍ ऄनलाआन‍ जमा‍ करना‍ होगा।‍ सोलर‍ म् ‍ हेतु‍ बुककग‍ ";

const good = analyzeTextQuality(clean.repeat(4));
const bad = analyzeTextQuality(garbled.repeat(4));

assert.equal(good.joinerChars, 0);
assert.equal(good.rareLetterChars, 0);
assert.ok(bad.joinerChars >= 20, `joiners: ${bad.joinerChars}`);
assert.ok(bad.rareLetterChars > 0);
assert.ok(bad.score <= 20, `garbled score should be very low, got ${bad.score}`);
assert.equal(bad.classification, "suspicious");
assert.ok(good.score - bad.score >= 40, `${good.score} vs ${bad.score}`);

// A few joiners in otherwise normal text are legitimate and not penalised.
const fewJoiners = analyzeTextQuality(
  clean.repeat(4).replace("क्षमतावार", "क्‍षमतावार"),
);
assert.equal(fewJoiners.joinerChars, 1);
// Only the token split changes; no joiner penalty applies.
assert.ok(Math.abs(fewJoiners.score - good.score) <= 3, `${fewJoiners.score} vs ${good.score}`);

// Broken conjuncts (7#162#20#2026 p.1, native layer): words start with vowel signs.
const brokenConjuncts = [
  "उ तर दे श शासन व त (सामा य) अनुभाग-2 सं या-7/2026 लखनऊ : दनांक : 02 िसत बर, 2026 कायालय ाप",
  "व तीय िनयम सं ह ख ड-2 भाग-2 से 4 के सहायक िनयम-153(1) एवं त म म िनगत शासनादे श के अधीन",
  "म हला सरकार कािमक को उनक स पूण सेवाकाल म सूित अवकाश दो बार तक क अनुम यता कितपय शत एवं ितबंध",
].join("\n");
const broken = analyzeTextQuality(brokenConjuncts.repeat(3));
assert.ok(broken.leadingMarkTokens >= 3, `leading marks: ${broken.leadingMarkTokens}`);
assert.ok(broken.score <= 55, `broken-conjunct page should be selected for OCR (<=55), got ${broken.score}`);
assert.equal(analyzeTextQuality(clean.repeat(4)).leadingMarkTokens, 0);

console.log("text-quality tests passed");
