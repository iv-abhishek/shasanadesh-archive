import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { COMMON_HINDI_WORDS, HINGLISH_ALIASES } from "./hindi-common-words";
import {
  Transliterator,
  convertFinishedWord,
  convertTrailingWord,
  phoneticToDevanagari,
  romanize,
  shouldTransliterate,
  undoConversion,
  wordAtCaret,
  type LexiconEntry,
} from "./transliterate";

// Romanisation (lexicon keys).
assert.equal(romanize("शासनादेश"), "shaasanaadesh");
assert.equal(romanize("क्या"), "kyaa");
assert.equal(romanize("पंप"), "pamp"); // dot before प = m
assert.equal(romanize("हिंदी"), "hindee");
assert.equal(romanize("ज़मीन"), "zameen");

// Rules for unknown words.
assert.equal(phoneticToDevanagari("kya"), "क्या");
assert.equal(phoneticToDevanagari("prakriya"), "प्रक्रिया");
assert.equal(phoneticToDevanagari("hindi"), "हिंदी");
assert.equal(phoneticToDevanagari("yojana"), "योजना");
assert.equal(phoneticToDevanagari("ghar"), "घर");

// Lexicon lookup: common words (+ the archive list when it has been built).
const lexiconFile = path.join(__dirname, "../public/translit/hi-lexicon.json");
const archive: LexiconEntry[] = existsSync(lexiconFile) ? JSON.parse(readFileSync(lexiconFile, "utf8")).words : [];
const t = new Transliterator([...COMMON_HINDI_WORDS.map((w): LexiconEntry => [w, 50]), ...archive], HINGLISH_ALIASES);
const first = (latin: string) => t.suggest(latin, 1)[0];
const sentence = (text: string) => text.split(" ").map(first).join(" ");
// Either correct spelling; the archive's own (पम्प) wins once its word list is loaded.
assert.match(sentence("solar pump lagwane hetu kya prakriya hai"), /^सोलर (पंप|पम्प) लगवाने हेतु क्या प्रक्रिया है$/);
assert.equal(sentence("vibhag ke adhikari ka vetan"), "विभाग के अधिकारी का वेतन");
assert.equal(first("shasnadesh"), "शासनादेश"); // misspelt, still found
assert.equal(first("yojna"), "योजना");
assert.equal(first("mein"), "में");
assert.equal(first("nahi"), "नहीं");
assert.notEqual(first("abhishek"), "बेसिक"); // consonants-only matches must look alike
assert.ok(t.complete("shasa").includes("शासनादेश"));

// What is left alone.
assert.equal(shouldTransliterate("GO", ""), false);
assert.equal(shouldTransliterate("PWD", "orders of "), false);
assert.equal(shouldTransliterate("solar", "abc*"), false);
assert.equal(shouldTransliterate("kya", ""), true);

// Editing: Space converts the finished word; Backspace right after undoes it.
{
  const before = "sarkari kya";
  const typed = "sarkari kya ";
  const done = convertFinishedWord(before, typed, typed.length, first);
  assert.equal(done?.value, "sarkari क्या ");
  assert.equal(done?.caret, "sarkari क्या ".length);
  const undone = undoConversion(done!.value, done!.caret, done!.conversion);
  assert.deepEqual(undone, { value: "sarkari kya", caret: "sarkari kya".length });
  assert.equal(undoConversion(done!.value, 3, done!.conversion), null); // caret elsewhere
  assert.equal(convertFinishedWord("GO", "GO ", 3, first), null);
  assert.equal(convertFinishedWord("kya", "kyaa", 4, first), null); // not a boundary
  assert.equal(convertFinishedWord("", "k ", 2, first), null); // pasted text is not typed word by word
}
assert.deepEqual(wordAtCaret("क्या yoj", 8), { start: 5, latin: "yoj" });
assert.equal(wordAtCaret("kya ", 4), null);
assert.match(convertTrailingWord("सोलर pump", first), /^सोलर (पंप|पम्प)$/);
assert.equal(convertTrailingWord("find GO", first), "find GO");

console.log(`transliteration tests passed (lexicon: ${archive.length} archive words)`);
