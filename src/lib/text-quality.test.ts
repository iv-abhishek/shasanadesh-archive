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

console.log("text-quality tests passed");
