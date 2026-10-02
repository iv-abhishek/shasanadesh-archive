/**
 * English (and common alternate) spellings → the Hindi words order subjects
 * use, for the order finder's word match (ADR-074). Subjects on the portal
 * are Hindi, so "solar pump" must also match "सोलर पम्प" / "सौर"; Hindi
 * spellings vary ("पम्प" / "पंप"), so either finds both. Deliberately small and
 * curated: a wrong synonym would list unrelated orders.
 */

const GROUPS: string[][] = [
  ["solar", "सोलर", "सौर"],
  ["pump", "pumps", "पम्प", "पंप", "पम्पों", "पंपों"],
  ["subsidy", "subsidies", "अनुदान", "सब्सिडी"],
  ["grant", "grants", "अनुदान"],
  ["pension", "pensions", "पेंशन", "पेन्शन"],
  ["transfer", "transfers", "स्थानान्तरण", "स्थानांतरण", "तबादला"],
  ["promotion", "promotions", "पदोन्नति", "प्रोन्नति"],
  ["recruitment", "भर्ती"],
  ["appointment", "appointments", "नियुक्ति"],
  ["salary", "pay", "वेतन"],
  ["allowance", "allowances", "भत्ता", "भत्ते"],
  ["leave", "अवकाश"],
  ["seniority", "ज्येष्ठता", "वरिष्ठता"],
  ["suspension", "निलम्बन", "निलंबन"],
  ["teacher", "teachers", "शिक्षक", "अध्यापक"],
  ["school", "schools", "विद्यालय", "स्कूल"],
  ["hospital", "hospitals", "चिकित्सालय", "अस्पताल"],
  ["doctor", "doctors", "चिकित्सक", "चिकित्साधिकारी"],
  ["farmer", "farmers", "कृषक", "किसान"],
  ["seed", "seeds", "बीज"],
  ["fertilizer", "fertiliser", "उर्वरक"],
  ["road", "roads", "मार्ग", "सड़क", "सडक"],
  ["bridge", "bridges", "सेतु", "पुल"],
  ["building", "buildings", "भवन"],
  ["construction", "निर्माण"],
  ["canal", "canals", "नहर"],
  ["irrigation", "सिंचाई"],
  ["electricity", "power", "विद्युत", "बिजली"],
  ["water", "जल", "पानी"],
  ["housing", "आवास"],
  ["land", "भूमि"],
  ["loan", "loans", "ऋण"],
  ["budget", "बजट"],
  ["purchase", "procurement", "क्रय", "खरीद"],
  ["tender", "tenders", "निविदा"],
  ["honorarium", "मानदेय"],
  ["scholarship", "scholarships", "छात्रवृत्ति"],
  ["police", "पुलिस"],
  ["prison", "jail", "कारागार", "जेल"],
  ["election", "elections", "निर्वाचन", "चुनाव"],
  ["retirement", "सेवानिवृत्ति"],
  ["sanction", "स्वीकृति"],
  ["scheme", "योजना"],
  ["guidelines", "guideline", "दिशा-निर्देश", "दिशानिर्देश", "मार्गदर्शिका"],
  ["kusum", "pm-kusum", "कुसुम"],
];

const LOOKUP = new Map<string, string[]>();
for (const group of GROUPS) {
  for (const word of group) {
    const key = word.toLowerCase();
    LOOKUP.set(key, [...new Set([...(LOOKUP.get(key) ?? []), ...group])]);
  }
}

/** The word and every spelling the glossary knows for it (lower-case for Latin). */
export function termVariants(word: string): string[] {
  const key = word.toLowerCase();
  return LOOKUP.get(key) ?? [word];
}

/**
 * A wildcard pattern with its Latin words swapped for their Hindi spellings
 * ("*solar पम्प*" → also "*सोलर पम्प*", "*सौर पम्प*"); at most `max` variants.
 */
export function patternVariants(pattern: string, max = 6): string[] {
  let variants = [pattern];
  for (const word of pattern.split(/[\s*?]+/).filter((part) => /^[a-z-]{3,}$/i.test(part))) {
    const alternatives = termVariants(word).filter((alt) => alt.toLowerCase() !== word.toLowerCase());
    if (!alternatives.length) continue;
    variants = variants.flatMap((variant) => [variant, ...alternatives.map((alt) => variant.split(word).join(alt))]);
    if (variants.length >= max) break;
  }
  return [...new Set(variants)].slice(0, max);
}
