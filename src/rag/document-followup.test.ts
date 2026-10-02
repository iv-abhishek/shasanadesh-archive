import assert from "node:assert/strict";
import { asksAboutLaterChanges, buildLaterChangesAnswer, refersToEarlierDocument } from "./document-followup.js";

// References to the document already in the conversation.
for (const query of [
  "क्या इस आदेश में बाद में कोई संशोधन हुआ है?",
  "उक्त शासनादेश अब भी लागू है?",
  "Has this order been amended?",
  "Is the above GO still in force?",
  "Was it superseded later?",
]) assert.equal(refersToEarlierDocument(query), true, query);
for (const query of [
  "सोलर पंप पर आदेश दिखाइए",
  "GeM खरीद की सीमा क्या है?",
  "latest orders on transfer policy",
  "राजपत्रित अधिकारी के अधिकृत होने के लिए कौन सा प्रमाणपत्र आवश्यक है?",
  "इसमें क्या शर्तें हैं?",
  "इस विषय पर नवीनतम आदेश दिखाइए",
]) assert.equal(refersToEarlierDocument(query), false, query);

assert.equal(asksAboutLaterChanges("क्या इस आदेश में बाद में कोई संशोधन हुआ है?"), true);
assert.equal(asksAboutLaterChanges("उक्त शासनादेश अब भी लागू है?"), true);
assert.equal(asksAboutLaterChanges("Has this order been amended?"), true);
assert.equal(asksAboutLaterChanges("इसमें क्या शर्तें हैं?"), false);

const document = { sourceId: "3#30#4#2024", title: "उत्तर प्रदेश सरकार की संहत निक्षेप निधि के गठन एवं प्रशासन के लिए संशोधित योजना।", goNumber: "3/2024/बी-4-590/दस-2024-10(4)/2006", goDate: "2024-09-30" };
const none = buildLaterChangesAnswer(document, [], "hi");
assert.match(none, /^संग्रह में उत्तर प्रदेश सरकार की संहत .* \(संख्या 3\/2024\/बी-4-590\/दस-2024-10\(4\)\/2006, दिनांक 30\.09\.2024\) \[S1\] को बाद में संशोधित, अतिक्रमित या निरस्त करने वाला कोई आदेश नहीं मिला।/);
const some = buildLaterChangesAnswer(
  document,
  [{ change: { kind: "amends", bySourceId: "9#30#4#2025", byGoNumber: "9/2025/बी-4", byGoDate: "2025-03-01" }, title: "संशोधन" }],
  "en",
);
assert.match(some, /After .* \[S1\], the archive has these orders that change it:/);
assert.match(some, /- dated 01\.03\.2025, GO 9\/2025\/बी-4 — संशोधन: amends it \[S2\]/);
assert.match(buildLaterChangesAnswer({ sourceId: "x", title: null, goNumber: null, goDate: null }, [], "en"), /^The archive has no later order that amends, supersedes or cancels this document \[S1\]\./);
console.log("document follow-up tests passed");
