import assert from "node:assert/strict";
import { trimIncompleteAnswer } from "./truncation.js";

// The 26 Sept "Project Alankar" answer, cut at the token limit.
const cut = [
  "प्रोजेक्ट अलंकार के शासनादेश के बारे में निम्नलिखित जानकारी उपलब्ध है:",
  "- शासनादेश के अंतर्गत बाउण्ड्रीवाल के निर्माण के लिए वित्तीय स्वीकृति दी गई है [S1 p.1]।",
  "- धनराशि स्वीकृत की गई है [S1 p.1]।",
  "- इस शासनादेश के अंतर्गत वित्तीय स्वीकृति के लिए निम्नलिखित शर्तें दी गई हैं:",
  "- कार्य की विशिष",
].join("\n");
assert.equal(
  trimIncompleteAnswer(cut),
  [
    "प्रोजेक्ट अलंकार के शासनादेश के बारे में निम्नलिखित जानकारी उपलब्ध है:",
    "- शासनादेश के अंतर्गत बाउण्ड्रीवाल के निर्माण के लिए वित्तीय स्वीकृति दी गई है [S1 p.1]।",
    "- धनराशि स्वीकृत की गई है [S1 p.1]।",
  ].join("\n"),
);

// Cut mid-sentence inside a paragraph: keep the complete sentences before it,
// including a citation that follows the full stop; dots inside citations don't count.
assert.equal(
  trimIncompleteAnswer("Maintenance is mandatory for five years. [S1 p.7] The helpline number, pump or controller will be sho"),
  "Maintenance is mandatory for five years. [S1 p.7]",
);
assert.equal(trimIncompleteAnswer("See [S1 p.7] and the hel"), "");

// Complete answers are unchanged; decimals are not sentence ends.
const whole = "The rate is 2.5 percent [S2 p.3].\n- Item one [S2 p.3].";
assert.equal(trimIncompleteAnswer(whole), whole);

console.log("truncation tests passed");
