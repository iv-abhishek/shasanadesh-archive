/**
 * Topic groups (ADR-064): which subject areas an order or rulebook belongs to,
 * from its subject, section, category and department (Hindi and English), or
 * from the core-rules catalogue. Codes are the rows of the `topics` table
 * (migration 011). An order can have several topics, or none.
 */

export const TOPIC_CODES = [
  "procurement", "gem", "financial-rules", "budget-accounts", "audit", "service", "pay-allowances", "pension",
  "conduct-discipline", "vigilance", "digital-it", "data-protection", "cybersecurity", "rti", "records-office",
  "grievances", "accessibility", "schemes", "works", "land-revenue", "education", "health", "agriculture", "law-order",
] as const;
export type TopicCode = (typeof TOPIC_CODES)[number];

const RULES: Array<[TopicCode, RegExp]> = [
  ["gem", /\bgem\b|जेम|गवर्नमेंट ई-?मार्केट|government e-?marketplace/i],
  ["procurement", /procure|purchase|tender|\bbid|क्रय|खरीद|अधिप्राप्ति|निविदा|टेण्डर|टेंडर|ई-?प्रोक्योरमेंट|आपूर्ति आदेश|make in india|मेक इन इंडिया/i],
  ["financial-rules", /financial (rules|powers|handbook)|delegation of financial|वित्तीय (नियम|हस्त ?पुस्तिका|अधिकार)|वित्तीय अधिकारों का प्रतिनिधायन|\bgfr\b|dfpr|बजट मैनुअल|budget manual/i],
  ["budget-accounts", /budget|sanction|allocation|grant no|accounts|बजट|वित्तीय स्वीकृति|प्रशासकीय (एवं|व) वित्तीय स्वीकृति|धनावंटन|धनराशि|अवमुक्त|अनुदान संख्या|लेखाशीर्षक|आहरण|कोषागार|treasury|pfms/i],
  ["audit", /\baudit|लेखा ?परीक्षा|ऑडिट|महालेखाकार|\bcag\b/i],
  ["service", /service rules|seniority|promotion|recruitment|transfer|posting|appointment|सेवा नियमावली|सेवा शर्त|वरिष्ठता|पदोन्नति|भर्ती|नियुक्ति|स्थानान्तरण|स्थानांतरण|तैनाती|संवर्ग|कार्मिक/i],
  ["pay-allowances", /\bpay\b|salary|allowance|dearness|\bda\b|वेतन|भत्ता|भत्ते|महंगाई|महँगाई|मानदेय|वेतनमान|एसीपी|acp/i],
  ["pension", /pension|gratuity|\bnps\b|\bgpf\b|retire|पेंशन|ग्रेच्युटी|सेवानिवृत्त|सामान्य भविष्य निधि|जीपीएफ|अंशदायी पेंशन/i],
  ["conduct-discipline", /conduct rules|discipline|disciplinary|suspension|आचरण|अनुशासन|निलम्बन|निलंबन|अनुशासनिक|दण्ड|दंड/i],
  ["vigilance", /vigilance|integrity pact|\bcvc\b|सतर्कता|भ्रष्टाचार/i],
  ["digital-it", /\bit\b policy|information technology|e-?office|website|software|digital|meity|gigw|cloud|आई\.?टी\.?|सूचना प्रौद्योगिकी|ई-?ऑफिस|डिजिटल|वेबसाइट|सॉफ्टवेयर/i],
  ["data-protection", /data protection|personal data|dpdp|open data|ndsap|डेटा संरक्षण|व्यक्तिगत डेटा/i],
  ["cybersecurity", /cyber|cert-in|information security|साइबर/i],
  ["rti", /right to information|\brti\b|सूचना का अधिकार|जन सूचना/i],
  ["records-office", /public records|record retention|office procedure|csmop|अभिलेख|कार्यालय पद्धति|पत्रावली/i],
  ["grievances", /grievance|cpgrams|शिकायत|जनसुनवाई|आईजीआरएस|igrs/i],
  ["accessibility", /disabilit|divyang|accessib|दिव्यांग|विकलांग/i],
  ["schemes", /scheme|yojana|योजना|मिशन|अभियान/i],
  ["works", /\bworks?\b|construction|road|bridge|building|निर्माण|मार्ग|सड़क|सेतु|भवन|मरम्मत|चौड़ीकरण|चौडीकरण|सुदृढ़ीकरण/i],
  ["land-revenue", /land|revenue|stamp|registration|भूमि|राजस्व|स्टाम्प|रजिस्ट्री|खतौनी|पट्टा/i],
  ["education", /education|school|college|university|teacher|शिक्षा|विद्यालय|महाविद्यालय|विश्वविद्यालय|शिक्षक|छात्र/i],
  ["health", /health|medical|hospital|ayush|चिकित्सा|स्वास्थ्य|अस्पताल|चिकित्सालय|आयुष/i],
  ["agriculture", /agricultur|farmer|crop|कृषि|किसान|फसल|उद्यान|पशु/i],
  ["law-order", /police|prison|jail|home guard|पुलिस|कारागार|बन्दी|बंदी|गृह विभाग|होमगार्ड/i],
];

// Catalogue topic words (datasets/core-rules) → topic codes.
const CATALOGUE_ALIASES: Record<string, TopicCode[]> = {
  financial: ["financial-rules"],
  budget: ["budget-accounts", "financial-rules"],
  consultancy: ["procurement"],
  services: ["procurement"],
  "make-in-india": ["procurement"],
  auction: ["gem"],
  conduct: ["conduct-discipline"],
};

export interface TopicInput {
  subject?: string | null;
  section?: string | null;
  category?: string | null;
  department?: string | null;
  catalogueTopics?: string[] | null;
}

export function topicsFor(input: TopicInput): TopicCode[] {
  const found = new Set<TopicCode>();
  for (const topic of input.catalogueTopics ?? []) {
    if ((TOPIC_CODES as readonly string[]).includes(topic)) found.add(topic as TopicCode);
    for (const alias of CATALOGUE_ALIASES[topic] ?? []) found.add(alias);
  }
  const text = [input.subject, input.section, input.category, input.department].filter(Boolean).join(" ").replace(/[‌‍]/g, "");
  for (const [topic, test] of RULES) if (test.test(text)) found.add(topic);
  // GeM is procurement too.
  if (found.has("gem")) found.add("procurement");
  return TOPIC_CODES.filter((code) => found.has(code));
}

/** Display names (same as the `topics` table, migration 011). */
export const TOPIC_NAMES: Record<TopicCode, { en: string; hi: string }> = {
  procurement: { en: "Procurement", hi: "क्रय एवं अधिप्राप्ति" },
  gem: { en: "GeM", hi: "जेम (GeM)" },
  "financial-rules": { en: "Financial rules and powers", hi: "वित्तीय नियम एवं अधिकार" },
  "budget-accounts": { en: "Budget, sanctions and accounts", hi: "बजट, स्वीकृतियाँ एवं लेखा" },
  audit: { en: "Audit", hi: "लेखा परीक्षा" },
  service: { en: "Service and personnel", hi: "सेवा एवं कार्मिक" },
  "pay-allowances": { en: "Pay and allowances", hi: "वेतन एवं भत्ते" },
  pension: { en: "Pension and retirement", hi: "पेंशन एवं सेवानिवृत्ति" },
  "conduct-discipline": { en: "Conduct and discipline", hi: "आचरण एवं अनुशासन" },
  vigilance: { en: "Vigilance", hi: "सतर्कता" },
  "digital-it": { en: "Digital and IT", hi: "डिजिटल एवं आईटी" },
  "data-protection": { en: "Data protection and open data", hi: "डेटा संरक्षण एवं ओपन डेटा" },
  cybersecurity: { en: "Cybersecurity", hi: "साइबर सुरक्षा" },
  rti: { en: "Right to Information", hi: "सूचना का अधिकार" },
  "records-office": { en: "Records and office procedure", hi: "अभिलेख एवं कार्यालय पद्धति" },
  grievances: { en: "Public grievances", hi: "जन शिकायत" },
  accessibility: { en: "Accessibility and disability", hi: "सुगम्यता एवं दिव्यांगजन" },
  schemes: { en: "Schemes", hi: "योजनाएँ" },
  works: { en: "Works and infrastructure", hi: "निर्माण कार्य" },
  "land-revenue": { en: "Land and revenue", hi: "भूमि एवं राजस्व" },
  education: { en: "Education", hi: "शिक्षा" },
  health: { en: "Health", hi: "स्वास्थ्य" },
  agriculture: { en: "Agriculture", hi: "कृषि" },
  "law-order": { en: "Home, police and prisons", hi: "गृह, पुलिस एवं कारागार" },
};

/**
 * Topic words in a question ("GeM guidelines", "पेंशन के शासनादेश") → topic codes
 * and the words that named them. Only unambiguous words: a topic filter narrows
 * a search, so "works" or "health" alone are left to subject matching.
 */
const QUERY_TOPICS: Array<[TopicCode, RegExp]> = [
  ["gem", /\bgem\b|जेम/gi],
  ["procurement", /\bprocurement\b|\bpurchase rules\b|क्रय|अधिप्राप्ति|खरीद/gi],
  ["financial-rules", /\bfinancial (?:rules|powers|guidelines)\b|\bgfr\b|\bdfpr\b|वित्तीय नियम|वित्तीय अधिकार/gi],
  ["pension", /\bpension\b|पेंशन/gi],
  ["conduct-discipline", /\bconduct rules\b|\bdisciplinary\b|आचरण|अनुशासन/gi],
  ["vigilance", /\bvigilance\b|सतर्कता/gi],
  ["rti", /\brti\b|right to information|सूचना का अधिकार/gi],
  ["cybersecurity", /\bcyber ?security\b|\bcert-in\b|साइबर/gi],
  ["data-protection", /\bdata protection\b|\bdpdp\b|डेटा संरक्षण/gi],
  ["digital-it", /\bgigw\b|\be-?office\b|\bit policy\b|ई-?ऑफिस/gi],
  ["grievances", /\bgrievances?\b|जन शिकायत/gi],
  ["accessibility", /\baccessibility\b|दिव्यांग/gi],
  ["audit", /\baudit\b|लेखा परीक्षा|ऑडिट/gi],
  ["pay-allowances", /\bdearness allowance\b|महंगाई भत्ता|महँगाई भत्ता/gi],
];

export function topicsInQuery(text: string): { topics: TopicCode[]; matched: string[] } {
  const topics = new Set<TopicCode>();
  const matched: string[] = [];
  for (const [topic, pattern] of QUERY_TOPICS) {
    for (const hit of text.matchAll(pattern)) {
      topics.add(topic);
      matched.push(hit[0]);
    }
  }
  return { topics: TOPIC_CODES.filter((code) => topics.has(code)), matched };
}
