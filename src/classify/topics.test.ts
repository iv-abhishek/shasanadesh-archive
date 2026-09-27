import assert from "node:assert/strict";
import { topicsFor } from "./topics.js";

assert.deepEqual(topicsFor({ subject: "जेम पोर्टल से क्रय की प्रक्रिया का निर्धारण" }), ["procurement", "gem"]);
assert.deepEqual(topicsFor({ catalogueTopics: ["financial", "procurement"] }), ["procurement", "financial-rules"]);
assert.ok(topicsFor({ subject: "सामान्य भविष्य निधि (जीपीएफ) अग्रिम" }).includes("pension"));
assert.ok(topicsFor({ subject: "वित्तीय वर्ष 2026-27 में प्रशासकीय एवं वित्तीय स्वीकृति", department: "लोक निर्माण विभाग" }).includes("budget-accounts"));
assert.ok(topicsFor({ subject: "केन्द्रीय कारागार में निरूद्ध सिद्धदोष बन्दी की समयपूर्व रिहाई" }).includes("law-order"));
assert.ok(topicsFor({ subject: "Guidelines for Indian Government Websites and Apps (GIGW 3.0)" }).includes("digital-it"));
assert.ok(topicsFor({ subject: "Digital Personal Data Protection Rules, 2025" }).includes("data-protection"));
assert.ok(topicsFor({ subject: "उत्तर प्रदेश सरकारी कर्मचारी आचरण नियमावली, 1956" }).includes("conduct-discipline"));
assert.deepEqual(topicsFor({ subject: "" }), []);
assert.deepEqual(topicsFor({ catalogueTopics: ["unknown"] }), []);
console.log("topic rules tests passed");
