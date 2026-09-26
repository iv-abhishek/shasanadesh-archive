/**
 * Pipeline stage: classification (pass 1 — rules on listing metadata)
 *
 * Purpose:
 *   Decide, from the listing alone (subject, category, section, department),
 *   what kind of order a document is and whether Ask should use it:
 *     tier A — generally applicable (rules, guidelines, policies, clarifications)
 *     tier B — useful in context (scheme guidelines, notifications, corrigenda, unknown)
 *     tier C — routine or individual (sanctions, releases, one person/place/case)
 *   See docs/ROADMAP.md §4.
 *
 * Invariants:
 *   - never deletes or hides anything by itself; tier is a retrieval setting
 *   - the subject line decides; the portal category is a weak hint (it is often
 *     wrong: prison releases appear as "अधिसूचना", sanctions as "सामान्य")
 *   - individual/case signals beat guideline words: "नीति-2022 के अन्तर्गत 10
 *     इकाइयों को … स्वीकृति" is a sanction under a policy, not the policy
 *   - low-confidence results are flagged for the model pass / human review
 *   - bump RULES_VERSION whenever a rule changes, so stored results can be redone
 */

export const RULES_VERSION = "rules-2026-09-26";

export type DocType =
  | "rules" // नियमावली, विनियम, rules and their amendments
  | "policy" // a policy document (नीति-2025) or its amendment
  | "guideline" // दिशा-निर्देश, SOP, procedure, manual
  | "clarification" // स्पष्टीकरण
  | "general-instruction" // an instruction to all departments/officers/employees
  | "scheme-guideline" // guidelines for one scheme
  | "notification" // अधिसूचना without a clearer type
  | "corrigendum" // शुद्धि-पत्र
  | "sanction" // financial / administrative sanction, release of funds, budget
  | "case-specific" // one person, place, project, unit, case or meeting
  | "reminder" // अनुस्मारक
  | "other";

export type Tier = "A" | "B" | "C";

export interface ClassificationInput {
  subject?: string | null;
  title?: string | null;
  category?: string | null;
  section?: string | null;
  department?: string | null;
  provider?: string | null;
}

export interface Classification {
  docType: DocType;
  tier: Tier;
  confidence: "high" | "low";
  /** Rule names that fired, for review and for tuning. */
  reasons: string[];
  rulesVersion: string;
}

/** Normalise: drop zero-width joiners and collapse whitespace. */
export function normalizeSubject(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface Rule {
  name: string;
  test: RegExp;
}

const rule = (name: string, test: RegExp): Rule => ({ name, test });

// Individual / case signals. "Hard" ones always win (a person, a company, a
// court case, a land parcel); "soft" ones (a district project, a purchase, a
// building) give way when the subject is clearly addressed to everyone.
const HARD_CASE_RULES: Rule[] = [
  rule("prison-release", /(बन्दी|बंदी|सिद्धदोष|कारागार).*(रिहाई|दयायाचिका|दया याचिका|पैरोल)|समयपूर्व रिहाई/),
  rule("named-person", /(पुत्र|पुत्री|पत्नी)\s+(श्री|स्व0|स्व\.)|निवासी\s*[-–]?\s*(जनपद|ग्राम)|^(सेवानिवृत्त\s+)?(न्यायमूर्ति\s+)?(श्री|श्रीमती|सुश्री|डॉ0|डा0|डॉ\.)\s*[\p{L}\p{M}]+|(श्री|श्रीमती|सुश्री)\s+[\p{L}\p{M}]+(\s+[\p{L}\p{M}]+){0,3}\s*(\(|,)?\s*[^।]{0,60}\s(को|की)\s/u),
  rule("named-staff-group", /\d+\s*(कार्मिकों|अधिकारियों|कर्मचारियों|शिक्षकों|प्रवक्ताओं)\s*(को|की)/),
  rule("company", /मेसर्स|मै0\s|प्रा\.?\s*लि|प्राइवेट\s*लिमिटेड|\bPvt\b|कम्पनी\s*लिमिटेड/),
  rule("court-case", /(वाद|याचिका|रिट|अवमानना)\s*(सं0|संख्या|सं\.)|मा0\s*(उच्च|सर्वोच्च)\s*न्यायालय|कामर्शियल कोर्ट|अधिकरण|ओ\s*ए\s*संख्या|O\.\s*A\./),
  rule("land-parcel", /(खसरा|गाटा|मौजा|परगना|अराजी)\s*(संख्या|सं0|नं)?/),
  rule("units-count", /\d+\s*(औद्योगिक\s*)?(इकाइयों|इकाईयों|इकाइयाँ|फर्मों)/),
  rule("nominate-members", /(सदस्य|अधिकारी)\s*नामित|नामांकन|बैठक\s*(हेतु|के सम्बन्ध|के संबंध|की कार्यवृत्त)|कार्यवृत्त|पीठासीन\s*अधिकारी/),
  rule("transfer-posting", /स्थानान्तरण|स्थानांतरण|तैनाती|कार्यमुक्त|प्रतिनियुक्ति पर|पदोन्नति\s*दिनांक|ए0\s*सी0\s*पी0/),
];

const SOFT_CASE_RULES: Rule[] = [
  rule("place", /^(जनपद|जिला|कमिश्नरेट|पुलिस\s*कमिश्नरेट)\s*[-–]?\s*[\p{L}\p{M}]|(थाना|पुलिस\s*चौकी|चौकियां|वाहिनी)\s|केन्द्रीय\s*कारागार|जिला\s*कारागार/u),
  rule("district-project", /जनपद\s*[-–]?\s*[\p{L}\p{M}]+.*(निर्माण|सुदृढ़ीकरण|सुदृढीकरण|चौड़ीकरण|चौडीकरण|विकास कार्य|मरम्मत|अनुरक्षण|स्थापना)/u),
  rule("construction", /निर्माण(ाधीन)?\s*(कार्य|हेतु|के|की)|भवनों?\s*(के|का)\s*निर्माण|बाउण्ड्री\s*वाल|बाउण्ड्रीवाल|टेण्डर|टेंडर|प्राक्कलन/),
  rule("procurement", /\d+\s*अदद|क्रय\s*(किये|किए|हेतु|के)|प्रतिस्थापन|साज-?सज्जा|अस्त्र-?शस्त्र/),
  rule("specific-institution-grant", /(विश्वविद्यालय|संस्थान|अकादमी|महाविद्यालय|चिकित्सालय|कारागार)[,\s].*(को|हेतु|के लिए).*(धनराशि|अनुदान|किश्त|स्वीकृति)/),
  rule("post-creation", /(पद|पदों|कोर्ट|न्यायालयों)\s*(के\s*)?सृजन|कोड\s*आवंटन/),
];

// Money: sanctions, releases, budget heads, re-appropriation.
const SANCTION_RULES: Rule[] = [
  // "वित्तीय वर्ष 2026-27 में/हेतु …" opens almost every allocation order (the
  // text layer sometimes splits the word: "वित्ती य", "वित्तीकय"). "… से" (from a
  // year onwards) is excluded: that is how new standing rules start.
  rule("financial-year", /^(विषय\s*[-:]?\s*)?(चालू\s*|वर्तमान\s*)?वित्ती\S*\s?\S?\s*वर्ष\s*\d{4}\s*-?\s*\d{0,4}\s*(में|मे|के|हेतु|की)\s/),
  rule("financial-sanction", /वित्तीय\s*स्वी[ाी]?कृति|प्रशासकीय\s*(एवं|व)\s*वित्तीय|वित्तीय\s*स्वीकृतियां/),
  rule("fund-release", /धनराशि|अवमुक्त|अवमुक्ति|किश्त|किस्त|आहरण|भुगतान\s*(हेतु|के सम्बन्ध)/),
  rule("budget-head", /अनुदान\s*(सं0|संख्या|सं\.)\s*-?\s*\d+|लेखाशीर्षक|आय-?व्ययक|पुनर्विनियोग|अनुपूरक\s*अनुदान|बजट\s*(आवंटन|प्राविधान)/),
  rule("salary-grant-item", /(गैर\s*)?वेतन\s*मद|एन0?पी0?एस0?\s*अंशदान/),
];

// Generally applicable documents.
const GENERAL_RULES: Array<Rule & { docType: DocType }> = [
  { ...rule("rules", /नियमावली|विनियमावली|विनियम,?\s*\d{4}|सेवा\s*नियम|नियम,?\s*\d{4}|अवकाश\s*नियम|नियमों|नियम\s*के\s|परन्तुक|रूल्स|\bRules\b/i), docType: "rules" },
  { ...rule("clarification", /स्पष्टीकरण|स्पष्ट\s*किए?\s*जाने|स्थिति\s*स्पष्ट/), docType: "clarification" },
  { ...rule("guideline", /दिशा-?\s*निर्देश|दिशानिर्देश|गाइड\s*लाइन|गाइडलाइन|मार्गदर्शिका|मार्गदर्शी|मानक\s*संचालन\s*प्रक्रिया|\bSOP\b|प्रक्रिया\s*(का\s*)?निर्धारण|प्रक्रिया\s*निर्धारित|नियमपुस्तिका|हस्तपुस्तिका|मैनुअल|Guidelines?/i), docType: "guideline" },
  { ...rule("policy", /नीति\s*[-–,]?\s*\d{4}(?!\s*(के|की)?\s*(अन्त|अंत))|नीति\s*\(\s*(प्रथम|द्वितीय|तृतीय)?\s*संशोधन|Policy\s*,?\s*\d{4}/i), docType: "policy" },
];

// Addressed to everyone rather than one case.
const BROAD_AUDIENCE = /^प्रदेश\s*(में|के)\s|प्रदेश\s*के\s*(समस्त|सभी|सेवारत|शासकीय|राजकीय)|सरकारी\s*कार्मिको|सरकारी\s*कार्मिकों|समस्त\s*(विभागों|विभागाध्यक्षों|जिलाधिकारियों|अधिकारियों|कार्यालयों)|सभी\s*(विभागों|अधिकारियों|कर्मचारियों)|राज्य\s*कर्मचारियों|शासकीय\s*(कर्मियों|सेवकों)|अधिकारियों\s*[/एवं]+\s*कर्मचारियों|सुनिश्चित\s*किये?\s*जाने|अनुपालन\s*सुनिश्चित|ऑनलाइन\s*प्रस्तुत|व्यवस्था\s*(के सम्बन्ध|लागू)/;

// Procedural subjects that usually apply generally (forms, time limits,
// certificates, record-keeping). Low confidence: reviewed later.
const PROCEDURE = /उपयोगिता\s*प्रमाण-?\s*पत्र|सेवा\s*पुस्तिका|प्रारूप|समय-?\s*सीमा|सरलीकरण|शपथ\s*पत्र|मानक\s*मद|व्यवस्था\s*लागू/;

// "परियोजना" (a project) is not a scheme.
const SCHEME = /(?<!परि)योजना|मिशन|कार्यक्रम|अभियान/;

function fired(rules: Rule[], text: string): string[] {
  return rules.filter((item) => item.test.test(text)).map((item) => item.name);
}

export function classifyOrder(input: ClassificationInput): Classification {
  const subject = normalizeSubject(input.subject || input.title || "");
  const category = normalizeSubject(input.category ?? "");
  const result = (docType: DocType, tier: Tier, confidence: "high" | "low", reasons: string[]): Classification => ({
    docType,
    tier,
    confidence,
    reasons,
    rulesVersion: RULES_VERSION,
  });

  // Central/other-source adapters publish guidance collections (GFR, OMs, manuals).
  if (input.provider && input.provider !== "shasanadesh-up") {
    if (!subject) return result("guideline", "A", "low", [`provider:${input.provider}`]);
  }

  if (!subject) {
    return result("other", "B", "low", ["no-subject"]);
  }

  const hardCases = fired(HARD_CASE_RULES, subject);
  const softCases = fired(SOFT_CASE_RULES, subject);
  const money = fired(SANCTION_RULES, subject);
  const general = GENERAL_RULES.filter((item) => item.test.test(subject));
  const broad = BROAD_AUDIENCE.test(subject);

  if (/शुद्धि-?\s*पत्र|शुद्धिपत्र|Corrigendum/i.test(subject)) {
    return result("corrigendum", "B", "high", ["corrigendum"]);
  }
  if (/अनुस्मारक/.test(subject) && !general.length) {
    return result("reminder", "C", "high", ["reminder"]);
  }

  // Individual cases first: they override guideline words used in passing.
  if (hardCases.length) {
    return result("case-specific", "C", "high", [...hardCases, ...softCases, ...money]);
  }
  if (softCases.length && !broad) {
    return result("case-specific", "C", general.length ? "low" : "high", [...softCases, ...money]);
  }

  if (general.length) {
    const top = general[0];
    const reasons = general.map((item) => item.name);
    // "… नीति-2022 के अंतर्गत … स्वीकृति": money under a policy is still money.
    if (money.length && !["rules", "clarification"].includes(top.docType) && !/दिशा-?\s*निर्देश|दिशानिर्देश|गाइडलाइन/.test(subject)) {
      return result("sanction", "C", "low", [...money, ...reasons]);
    }
    if (top.docType === "guideline" && SCHEME.test(subject) && !broad) {
      return result("scheme-guideline", "B", "high", [...reasons, "scheme"]);
    }
    return result(top.docType, "A", "high", reasons);
  }

  if (money.length) {
    return result("sanction", "C", "high", money);
  }

  if (broad) {
    return result("general-instruction", "A", "low", ["broad-audience"]);
  }

  if (PROCEDURE.test(subject) && !SCHEME.test(subject)) {
    return result("general-instruction", "A", "low", ["procedure-words"]);
  }

  if (SCHEME.test(subject)) {
    return result("other", "B", "low", ["scheme-related"]);
  }

  // Weak hints from the portal category.
  if (/दिशा-?\s*निर्देश|नीतिगत|नीतियों|नीतियोँ/.test(category)) {
    return result(SCHEME.test(subject) ? "scheme-guideline" : "guideline", SCHEME.test(subject) ? "B" : "A", "low", ["category:guideline"]);
  }
  if (/वित्तीय\s*स्वीकृति|बजट|अनुदान|वित्तीय/.test(category)) {
    return result("sanction", "C", "low", ["category:finance"]);
  }
  if (/अधिसूचना/.test(category) || /अधिसूचना/.test(subject)) {
    return result("notification", "B", "low", ["notification"]);
  }

  return result("other", "B", "low", ["unmatched"]);
}
