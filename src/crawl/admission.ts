/**
 * Pipeline stage: crawl — what is worth keeping (ADR-097, ADR-103)
 *
 * Purpose:
 *   Decide from a listing entry's title and row alone whether a crawled
 *   document belongs in the archive, and what kind of document it is, before
 *   anything is downloaded. Tenders, recruitment results, events and orders
 *   about named individuals are left out (docs/KNOWLEDGE_SOURCES.md); budget
 *   releases are kept as records for listing questions.
 *
 * Invariants:
 *   - a dropped entry keeps its reason, so the dry-run report shows the owner
 *     exactly what was left out and why
 *   - this is a first, cheap filter; the classification pass still grades
 *     every admitted document into tiers after ingestion
 */

import type { ListingItem } from "./extract.js";
import type { CrawlSite } from "./register.js";

export type CrawlKind =
  | "act-rules"
  | "go"
  | "circular"
  | "notification"
  | "policy"
  | "guideline"
  | "budget-release"
  | "gazette"
  | "report"
  | "notice"
  | "other";

export interface Admission {
  admitted: boolean;
  kind: CrawlKind;
  /** Why it was dropped (null when admitted). */
  reason: string | null;
}

interface Rule {
  reason: string;
  pattern: RegExp;
}

// Order matters: the first matching rule names the reason.
const DROP: Rule[] = [
  { reason: "tender", pattern: /\b(e-?tender( notice)?s?|tender (notice|document|for|no\.?)|nit|rfp|rfq|eoi|expression of interest|bid document|corrigendum.{0,40}\b(tender|nit|bid|rfp)|quotations?|auction notice)\b|निविदा (सूचना|आमंत्रण|प्रपत्र)|ई-निविदा|अल्पकालीन निविदा|कोटेशन|नीलामी (सूचना|विज्ञप्ति)|ई-टेंडर/i },
  { reason: "recruitment/exam", pattern: /\b(recruitment|vacanc(y|ies)|admit card|merit list|answer key|result|interview|walk-?in|shortlisted|selection list|exam(ination)? (schedule|date|centre))\b|भर्ती (विज्ञापन|सूचना)|रिक्तियों? (का|की|हेतु) विज्ञापन|प्रवेश पत्र|मेरिट (सूची|लिस्ट)|परीक्षा परिणाम|परिणाम घोषित|साक्षात्कार|चयन सूची|उत्तर कुंजी/i },
  { reason: "event/press", pattern: /\b(press (release|note)|photo gallery|news ?letter|celebration|workshop on|webinar|invitation|programme schedule)\b|प्रेस विज्ञप्ति|समारोह|आमंत्रण|कार्यशाला का आयोजन|फोटो/i },
  { reason: "RTI list", pattern: /\b(rti (reply|application|appeal)s?|right to information.*(list|reply))\b|जन सूचना अधिकारी की सूची/i },
  {
    reason: "individual personnel order",
    pattern: /\b(transfer(red)?|posting|suspension|suspended|reinstatement|relieving|charge handed|attachment) (order )?(of|in respect of) (shri|smt|sri|mr|ms|dr)\b|(श्री|श्रीमती|सुश्री|डॉ0?)\s*\S+.*(का|के|की) (स्थानान्तरण|स्थानांतरण|तैनाती|निलम्बन|निलंबन|सम्बद्धीकरण|कार्यमुक्त)|(स्थानान्तरण|स्थानांतरण|तैनाती|निलम्बन|निलंबन) (आदेश )?(श्री|श्रीमती|सुश्री)/i,
  },
  { reason: "seniority/gradation list", pattern: /\b(seniority|gradation) list\b|ज्येष्ठता सूची|वरिष्ठता सूची|पदोन्नति सूची/i },
  { reason: "leave/court case of an individual", pattern: /\b(writ petition|contempt|w\.?p\.? ?no)\b.*\b(shri|smt)\b|अवमानना याचिका/i },
];

const KINDS: Array<{ kind: CrawlKind; pattern: RegExp }> = [
  { kind: "budget-release", pattern: /\b(release of (funds|amount|grant)|sanction(ed)? (of|for) (rs|amount|funds)|financial sanction|fund release|allocation of funds)\b|धनराशि.{0,40}(अवमुक्त|स्वीकृत|आवंटन|निर्गत)|(अवमुक्त|स्वीकृत).{0,20}धनराशि|वित्तीय स्वीकृति|बजट आवंटन|अनुदान.{0,20}(अवमुक्त|स्वीकृत)/i },
  { kind: "act-rules", pattern: /\b(act|rules|regulations?|manual|handbook|code|niyamavali)\b,?\s*(\d{4}|$)|अधिनियम|नियमावली|नियमसंग्रह|विनियमावली|संहिता|हस्तपुस्तिका|मैनुअल/i },
  { kind: "gazette", pattern: /\bgazette\b|गजट|गज़ट|असाधारण/i },
  { kind: "notification", pattern: /\bnotification\b|अधिसूचना/i },
  { kind: "policy", pattern: /\bpolicy\b|नीति[\s,-]*\d{4}|नीति$/i },
  { kind: "guideline", pattern: /\b(guidelines?|sop|standard operating procedure|instructions?)\b|दिशा-?\s?निर्देश|मार्गदर्शिका|मार्गदर्शी सिद्धान्त/i },
  { kind: "circular", pattern: /\b(circular|office memorandum|o\.?m\.?)\b|परिपत्र|कार्यालय ज्ञाप/i },
  { kind: "report", pattern: /\b(annual report|report|statistics|data book|progress report)\b|प्रतिवेदन|वार्षिक रिपोर्ट|सांख्यिकी/i },
  { kind: "go", pattern: /\b(g\.?o\.?|government order)\b|शासनादेश|शासनादेशों/i },
  { kind: "notice", pattern: /\b(notice|public notice)\b|सूचना$|विज्ञप्ति/i },
];

export function kindOf(text: string, site: Pick<CrawlSite, "docTypes">): CrawlKind {
  for (const { kind, pattern } of KINDS) if (pattern.test(text)) return kind;
  // Nothing in the title: fall back to what the register says the listing holds.
  const first = site.docTypes[0];
  if (first === "rules") return "act-rules";
  if (first && ["go", "circular", "notification", "policy", "guideline", "budget-release", "notice"].includes(first)) return first as CrawlKind;
  return "other";
}

// A rule, GO or guideline about tenders or recruitment ("भर्ती नियमावली", "tender
// guidelines") is exactly what officers ask about; only the notices themselves go.
const RULE_WORDS = /शासनादेश|दिशा-?\s?निर्देश|नियमावली|नियम|नीति|प्रक्रिया|\b(guidelines?|policy|procedure|rules|manual|g\.?o\.?|government order|office memorandum|circular)\b/i;
const RULE_SAFE_REASONS = new Set(["tender", "recruitment/exam"]);

export function admit(item: ListingItem, site: Pick<CrawlSite, "docTypes" | "level">): Admission {
  const text = [item.title, item.linkLabel].join(" ");
  const kind = kindOf(text, site);
  const ruleLike = RULE_WORDS.test(text);
  for (const { reason, pattern } of DROP) {
    if (ruleLike && RULE_SAFE_REASONS.has(reason)) continue;
    if (pattern.test(text)) return { admitted: false, kind, reason };
  }
  // District notices are local news (meetings, camps, lists); keep their orders only.
  if (site.level === "district" && kind === "notice") return { admitted: false, kind, reason: "district notice" };
  return { admitted: true, kind, reason: null };
}
