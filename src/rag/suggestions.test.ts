import assert from "node:assert/strict";
import { buildSuggestionMessages, fallbackSuggestions, listingSuggestions, parseSuggestions } from "./suggestions.js";

const en = { question: "What is the GeM purchase limit?", language: "en" as const };
const hi = { question: "जेम से क्रय की सीमा क्या है?", language: "hi" as const };

// JSON reply, cleaned: question marks added, URLs and repeats dropped, max three.
assert.deepEqual(
  parseSuggestions('<think>x</think>["Who approves purchases above the limit", "What is the GeM purchase limit?", "See https://www.staffnews.in/x", "Which documents are required?", "Is it mandatory for all departments?"]', en),
  ["Who approves purchases above the limit?", "Which documents are required?", "Is it mandatory for all departments?"],
);
// Numbered lines instead of JSON.
assert.deepEqual(parseSuggestions("1. क्रय समिति कौन गठित करता है?\n2) प्रत्यक्ष क्रय की सीमा क्या है?\n- Which rule applies?", hi), [
  "क्रय समिति कौन गठित करता है?",
  "प्रत्यक्ष क्रय की सीमा क्या है?",
]); // English line dropped for a Hindi answer

// Order lists.
assert.deepEqual(
  listingSuggestions({ ...hi, answer: "", listing: true, sources: [{ goNumber: "51/2026", goDate: "2026-09-21" }, { goNumber: null }, { goNumber: "50/2026" }] }).slice(0, 2),
  ["शासनादेश संख्या 51/2026 दिनांक 21.09.2026 में क्या निर्देश हैं?", "शासनादेश संख्या 50/2026 में क्या निर्देश हैं?"],
);
assert.equal(fallbackSuggestions(en).length, 3);

// The prompt carries language, question, answer without citations, and the cited orders.
const messages = buildSuggestionMessages({ ...en, answer: "Up to Rs X [S1 p.2].", sources: [{ title: "GeM GO", goNumber: "57/2024", goDate: "2024-11-26", department: "MSME" }] });
assert.match(messages[1].content, /LANGUAGE: English/);
assert.doesNotMatch(messages[1].content, /\[S1 p\.2\]/);
assert.match(messages[1].content, /GeM GO · MSME · GO 57\/2024 · 2024-11-26/);

console.log("suggestion tests passed");
