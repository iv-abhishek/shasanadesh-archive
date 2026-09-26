import assert from "node:assert/strict";
import { classifyOrder } from "./rules.js";

// Hand-labelled subjects from real portal listings (26 Sept 2026).
const cases: Array<[string, string, string]> = [
  // [expected tier, expected docType, subject]
  ["A", "rules", "इलाहाबाद उच्च न्यायालय कोर्ट मैनेजर केंद्रीयकृत सेवा नियमावली"],
  ["A", "rules", "प्रसूति अवकाश नियम के 02 वर्ष सम्बन्धी प्रतिबन्ध/परन्तुक को विलोपित किये जाने के सम्बन्ध में।"],
  ["A", "policy", "''उत्तर प्रदेश खिलौना विनिर्माण प्रोत्साहन नीति-2025''"],
  ["A", "policy", "उ0प्र0 सूचना प्रौद्योगिकी एवं सूचना प्रौद्योगिकी जनित सेवा नीति 2022 (प्रथम संशोधन)"],
  ["A", "guideline", "उत्तर प्रदेश स्टार्टअप नीति, 2026 के अंतर्गत डीपटेक स्टार्टअप्स हेतु दिशा-निर्देशों के संबंध में।"],
  ["A", "general-instruction", "प्रदेश के सेवारत एवं सेवानिवृत्त शासकीय कर्मियों के चिकित्सा प्रतिपूर्ति दावों को ऑनलाइन प्रस्तुत किये जाने के संबंध में।"],
  ["A", "general-instruction", "सरकारी कार्मिको की सेवा पुस्तिका मानव सम्पदा पोर्टल पर अद्यतन कराये जाने के सम्बन्ध में।"],
  ["A", "general-instruction", "वित्तीय वर्ष 2027-2028 से मानक मदों (आब्जेक्ट हेड्स) की नई व्यवस्था लागू किये जाने के सम्बन्ध में ।"],
  ["B", "scheme-guideline", "'रानी लक्ष्मीबाई स्कूटी योजना' के क्रियान्वयन के संबंध में दिशा-निर्देश।"],
  ["B", "corrigendum", "शासनादेश संख्या- 42/2026/77-1002-2-2021/001-467, दिनांक 21.07.2026 का शुद्धि-पत्र।"],
  ["C", "case-specific", "केन्द्रीय कारागार, आगरा में निरूद्ध सिद्धदोष बन्दी गुड्डू पुत्र श्री त्रिलोकी, निवासी जनपद-फिरोजाबाद की फार्म-ए/लाईसेंस के आधार पर समयपूर्व रिहाई के सम्बन्ध में।"],
  ["C", "case-specific", "उत्तर प्रदेश दुग्धशाला विकास एवं दुग्ध उत्पाद प्रोत्साहन नीति-2022 के अन्तार्गत मेसर्स देशरानी मिल्क एण्ड चिलिंग सेन्टर को प्रोत्साहन"],
  ["C", "case-specific", "उ0प्र0 औद्योगिक निवेश एवं रोजगार प्रोत्साहन नीति-2022 के अन्तर्गत मेगा/सुपर मेगा श्रेणी की 08 इकाईयों को 'लेटर ऑफ कम्फर्ट'(एल.ओ.सी.) निर्गत हेतु अनुमोदन"],
  ["C", "case-specific", "श्री अजय कृष्णा (एच0जे0एस0), सेवानिवृत्त न्यायाधीश को पीठासीन अधिकारी नियुक्त किये जाने के सम्बन्ध में।"],
  ["C", "case-specific", "24 कार्मिकों को द्वितीय वित्तीय सुनिश्चित कैरियर प्रोन्नयन (ए0सी0पी0) का लाभ"],
  ["C", "case-specific", "जनपद उन्नाव के थाना बीघापुर क्षेत्रान्तर्गत नवीन पुलिस चौकी इन्दौली के भवन निर्माण हेतु"],
  ["C", "case-specific", "विभागीय क्रय समिति की बैठक हेतु सदस्य नामित करने के संबंध में।"],
  ["C", "sanction", "वित्तीय वर्ष 2026-27 में धर्मार्थ कार्य योजनान्तर्गत आगरा मण्डल के मन्दिरों का जीर्णोद्धार"],
  ["C", "sanction", "वित्तीय वर्ष 2026-27 में एन0पी0एस0 अंशदान के लिए धनराशि की स्वीकृति।"],
  ["C", "reminder", "संतुलित क्षेत्रीय विकास (पूर्वांचल/बुन्देलखण्ड) निधि राज्यांश के अन्तर्गत कार्ययोजना उपलब्ध कराए जाने के सम्बन्ध में अनुस्मारक-पत्र"],
];

let failures = 0;
for (const [tier, docType, subject] of cases) {
  const got = classifyOrder({ subject });
  if (got.tier !== tier || got.docType !== docType) {
    failures++;
    console.error(`MISMATCH expected ${tier}/${docType}, got ${got.tier}/${got.docType} [${got.reasons.join("+")}]: ${subject}`);
  }
}
assert.equal(failures, 0, `${failures} classification mismatches`);

// Zero-width joiners (common in portal text) do not change the result.
assert.equal(
  classifyOrder({ subject: "राज्‍य कर्मचारियों को स्वीकृत भवन निर्माण अग्रिम के ऑकड़ों के मिलान के सम्बन्ध में।" }).tier,
  "A",
);

// No subject: kept (tier B, low confidence) for the model pass; adapters default to A.
assert.deepEqual(
  [classifyOrder({}).tier, classifyOrder({}).confidence],
  ["B", "low"],
);
assert.equal(classifyOrder({ provider: "doe-gfr" }).tier, "A");

console.log(`classification rule tests passed (${cases.length} labelled subjects)`);
