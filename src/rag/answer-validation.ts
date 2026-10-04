import type { RetrievalEvidence } from "./types.js";
import { toAsciiDigits } from "../lib/numeric-tokens.js";

export type AnswerValidationIssueCode =
  | "empty_answer"
  | "missing_citation"
  | "invalid_citation"
  | "uncited_numeric_claim"
  | "unsafe_numeric_claim"
  | "unsupported_numeric_claim"
  | "internal_placeholder";

export interface AnswerValidationIssue {
  code: AnswerValidationIssueCode;
  message: string;
  excerpt?: string;
}

export interface AnswerValidationResult {
  ok: boolean;
  issues: AnswerValidationIssue[];
  citations: string[];
}

const CITATION_RE = /\[(S\d+)\s+p\.(\d+)\]/g;

// Government-order numerics are safety-sensitive because OCR can alter years,
// dates, amounts, percentages, rule/section numbers, levels, and identifiers.
// Devanagari digits are included as well as ASCII digits.
const NUMERIC_TOKEN_RE =
  /(?:[0-9०-९]+(?:[.,:/-][0-9०-९]+)*)/g;

const INTERNAL_PLACEHOLDER_RE =
  /\[+UNVERIFIED_NUMERIC\]+|<+UNVERIFIED_NUMERIC>+|\bUNVERIFIED_NUMERIC\b/i;

// An explicit statement that a value is unverified / must be checked against the
// cited page. Bare words such as "OCR" or "verification" are not enough: they
// also occur in ordinary government-order subjects (e.g. "character
// verification").
const CAUTION_RE =
  /\b(?:unverified|not (?:been )?verified|(?:requires?|needs?) (?:verification|checking)|(?:should|must) be (?:verified|checked)|verify (?:(?:it|this|these|them|the (?:value|number|date|figure|amount)) )?against|check(?:ed)? against|(?:original|cited) (?:source )?page|source page)\b|(?:असत्यापित|सत्यापित नहीं|सत्यापन आवश्यक|सत्यापन की आवश्यकता|मूल पृष्ठ|मूल पेज|मूल आदेश से (?:जाँच|जांच|मिलान|पुष्टि)|पुष्टि (?:करें|आवश्यक))/iu;

// Leading list numbering ("1.", "2)") is formatting, not a numeric claim.
const LIST_MARKER_RE =
  /^\s*(?:[-–—•*]\s*)?[0-9०-९]{1,2}[.)]\s*/u;

function withoutListMarker(unit: string): string {
  return unit.replace(LIST_MARKER_RE, "");
}

// Digit groups used to check that a number in the answer really appears on a
// cited page. Thousands separators are dropped and Devanagari digits are
// normalised so "५०,०००" and "50000" compare equal.
function digitGroups(text: string): string[] {
  return (
    toAsciiDigits(text)
      .replace(/(\d),(?=\d)/g, "$1")
      .match(/\d+/g) ?? []
  ).map((group) => group.replace(/^0+(?=\d)/, ""));
}

/**
 * Numbers that name things rather than state facts: the years and numbers in
 * the cited documents' titles and GO numbers ("GFR 2017", "Manual … 2025"),
 * and the numbers the officer typed in the question. A sentence whose only
 * digits are these is not a numeric claim (3 Oct: salvage dropped every line
 * that mentioned "GFR 2017" and kept one stray fragment).
 */
function namedNumbers(evidence: RetrievalEvidence[], question = ""): Set<string> {
  return new Set([
    ...digitGroups(question),
    ...evidence.flatMap((item) => [
      ...digitGroups(item.document_title ?? ""),
      ...digitGroups(item.go_number ?? ""),
      ...digitGroups(item.go_date ?? ""),
    ]),
  ]);
}

function hasNumericClaim(text: string, named: Set<string>): boolean {
  NUMERIC_TOKEN_RE.lastIndex = 0;
  if (!NUMERIC_TOKEN_RE.test(text)) {
    NUMERIC_TOKEN_RE.lastIndex = 0;
    return false;
  }
  NUMERIC_TOKEN_RE.lastIndex = 0;
  return digitGroups(text).some((group) => !named.has(group));
}

function numbersSupportedBy(
  unit: string,
  evidence: RetrievalEvidence[],
): boolean {
  const needed = digitGroups(unit);

  if (needed.length === 0) {
    return true;
  }

  const available = new Set(
    evidence.flatMap((item) => [
      ...digitGroups(item.selected_page_text ?? ""),
      ...digitGroups(item.canonical_page_text ?? ""),
    ]),
  );

  return needed.every((group) => available.has(group));
}

function citationKey(
  label: string,
  pageNumber: number,
): string {
  return `${label}:${pageNumber}`;
}

function isRiskyNumericEvidence(
  evidence: RetrievalEvidence,
): boolean {
  return (
    evidence.numeric_verification_status === "conflict" ||
    evidence.numeric_verification_status === "ocr_only_unverified" ||
    evidence.numeric_verification_status === "unverified"
  );
}

function extractCitations(
  text: string,
): Array<{
  raw: string;
  label: string;
  pageNumber: number;
}> {
  const citations: Array<{
    raw: string;
    label: string;
    pageNumber: number;
  }> = [];

  for (const match of text.matchAll(CITATION_RE)) {
    citations.push({
      raw: match[0],
      label: match[1],
      pageNumber: Number.parseInt(match[2], 10),
    });
  }

  return citations;
}

function stripCitations(text: string): string {
  return text.replace(CITATION_RE, "");
}

/** True when a fragment is only citations and punctuation, with no words. */
function isCitationOnly(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(stripCitations(text));
}

/**
 * Split an answer into claim units (sentences within lines). Models often put
 * the citation after the full stop — "…दी गई है। [S1 p.1]" — so a citation-only
 * fragment belongs to the sentence before it (26 Sept).
 *
 * Each unit keeps the line (bullet or paragraph line) it belongs to. A
 * bullet often holds two sentences and one citation at its end ("… 10 per
 * cent of the contract price. It is interest-bearing [S2 p.132]"): the
 * earlier sentence is covered by the citation later in the same line
 * (4 Oct eval: such sentences failed as uncited and every figure was dropped).
 */
function claimUnitsByLine(text: string): Array<{ text: string; line: number }> {
  const units: Array<{ text: string; line: number }> = [];
  text.split(/\n+/u).forEach((lineText, line) => {
    const parts = lineText
      .split(/(?<=[.!?।])\s+/u)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const part of parts) {
      const bare = part.replace(/^\s*(?:[-–—•*]+|\d+[.)])\s*/, "");
      if (units.length > 0 && isCitationOnly(bare)) {
        units[units.length - 1].text = `${units[units.length - 1].text} ${bare}`;
      } else {
        units.push({ text: part, line });
      }
    }
  });
  return units;
}

/** Citations a unit relies on: its own, else those of the next cited unit on the same line. */
function unitCitationsWithLine(
  units: Array<{ text: string; line: number }>,
  index: number,
): Array<{ raw: string; label: string; pageNumber: number }> {
  const own = extractCitations(units[index].text);
  if (own.length) return own;
  for (let next = index + 1; next < units.length && units[next].line === units[index].line; next++) {
    const later = extractCitations(units[next].text);
    if (later.length) return later;
  }
  return [];
}

/**
 * True when every number of the claim is printed on the page in at least two
 * different text extractions (native text and OCR). A page flagged for a
 * numeric conflict somewhere (often just a page number or a garbled year) is
 * still reliable for the numbers both extractions agree on (4 Oct: "30%" on
 * the UP GeM GO page was refused because "2017" read as "207" elsewhere).
 */
function variantsAgreeOn(digits: string, item: RetrievalEvidence): boolean {
  const needed = digitGroups(digits);
  if (!needed.length) return true;
  const texts = [...new Set([item.selected_page_text, item.canonical_page_text, ...(item.other_variant_texts ?? [])].filter(Boolean))];
  const holding = texts.filter((text) => {
    const groups = new Set(digitGroups(text));
    return needed.every((group) => groups.has(group));
  });
  return holding.length >= 2;
}

/** The problem with one numeric claim unit, or null when it is cited, safe and supported. */
function numericUnitIssue(
  unit: string,
  unitCitations: Array<{ label: string; pageNumber: number }>,
  evidenceByKey: Map<string, RetrievalEvidence>,
  named: Set<string>,
): AnswerValidationIssue | null {
  const withoutCitations = stripCitations(unit);
  if (!hasNumericClaim(withoutCitations, named)) return null;

  if (unitCitations.length === 0) {
    return {
      code: "uncited_numeric_claim",
      message: "A numeric claim must have a source-page citation in the same sentence or line.",
      excerpt: unit.slice(0, 240),
    };
  }

  const citedEvidence = unitCitations
    .map((citation) => evidenceByKey.get(citationKey(citation.label, citation.pageNumber)))
    .filter((item): item is RetrievalEvidence => Boolean(item));

  // The sentence explicitly flags the value as needing verification.
  if (CAUTION_RE.test(unit)) return null;

  const claimDigits = digitGroups(withoutCitations).filter((group) => !named.has(group)).join(" ");
  const safeCitedEvidence = citedEvidence.filter(
    (item) => !isRiskyNumericEvidence(item) || variantsAgreeOn(claimDigits, item),
  );

  if (citedEvidence.length > 0 && safeCitedEvidence.length === 0) {
    return {
      code: "unsafe_numeric_claim",
      message:
        "A numeric claim relies only on OCR-conflicted or OCR-only-unverified evidence and is stated without an explicit source-page verification warning.",
      excerpt: unit.slice(0, 240),
    };
  }

  // Citing one reliable page is not enough: the numbers themselves must
  // appear on a reliable cited page. Otherwise the value may have come from
  // a risky page cited alongside it, or been produced by the model.
  if (safeCitedEvidence.length > 0 && !numbersSupportedBy(claimDigits, safeCitedEvidence)) {
    return {
      code: "unsupported_numeric_claim",
      message: "A numeric value does not appear on any cited page with reliable (native-text) numerics.",
      excerpt: unit.slice(0, 240),
    };
  }
  return null;
}

export function validateAnswer(
  answer: string,
  evidence: RetrievalEvidence[],
  question = "",
): AnswerValidationResult {
  const named = namedNumbers(evidence, question);
  const issues: AnswerValidationIssue[] = [];
  const trimmed = answer.trim();

  // Citations with no words ("• [S1 p.1]" lines) are not an answer.
  if (!trimmed || isCitationOnly(trimmed)) {
    return {
      ok: false,
      issues: [
        {
          code: "empty_answer",
          message: "Generator returned an empty answer.",
        },
      ],
      citations: [],
    };
  }

  if (INTERNAL_PLACEHOLDER_RE.test(trimmed)) {
    issues.push({
      code: "internal_placeholder",
      message:
        "Internal generation-safety placeholders must not appear in the user-facing answer.",
      excerpt:
        trimmed.match(INTERNAL_PLACEHOLDER_RE)?.[0],
    });
  }

  const evidenceByKey = new Map(
    evidence.map((item) => [
      citationKey(item.label, item.page_number),
      item,
    ]),
  );

  const citations = extractCitations(trimmed);

  if (
    evidence.length > 0 &&
    citations.length === 0
  ) {
    issues.push({
      code: "missing_citation",
      message:
        "The answer contains no source-page citation even though evidence was supplied.",
    });
  }

  for (const citation of citations) {
    const key = citationKey(
      citation.label,
      citation.pageNumber,
    );

    if (!evidenceByKey.has(key)) {
      issues.push({
        code: "invalid_citation",
        message:
          `Citation ${citation.raw} does not match any supplied evidence page.`,
        excerpt: citation.raw,
      });
    }
  }

  const units = claimUnitsByLine(trimmed);
  units.forEach((rawUnit, index) => {
    const unit = withoutListMarker(rawUnit.text);
    const issue = numericUnitIssue(unit, unitCitationsWithLine(units, index), evidenceByKey, named);
    if (issue) issues.push(issue);
  });

  return {
    ok: issues.length === 0,
    issues,
    citations: citations.map(
      (citation) => citation.raw,
    ),
  };
}

export function buildAnswerRepairInstruction(
  originalAnswer: string,
  validation: AnswerValidationResult,
): string {
  const issueText = validation.issues
    .map(
      (issue, index) =>
        `${index + 1}. ${issue.code}: ${issue.message}` +
        (issue.excerpt
          ? `\n   Problem excerpt: ${issue.excerpt}`
          : ""),
    )
    .join("\n");

  // Only a leaked placeholder calls for dropping every figure. A figure that
  // is uncited or not on its cited page is fixed where it stands; the other
  // figures stay (4 Oct eval: one bad number made the repair remove the
  // 40/50/80% and 30% that officers asked for).
  const strictQualitativeMode =
    validation.issues.some(
      (issue) => issue.code === "internal_placeholder",
    );

  const strictRules =
    strictQualitativeMode
      ? [
          "STRICT QUALITATIVE REPAIR MODE:",
          "- Remove every UNVERIFIED_NUMERIC placeholder from the final answer.",
          "- Do not state any exact year, date, amount, percentage, level number, rule number, section number, GO number, serial number, or identifier.",
          "- Do not guess or reconstruct a masked value.",
          "- Rewrite around those values using qualitative wording such as 'the relevant grade/level' or 'the applicable seniority rules'.",
          "- Numeric characters may appear only inside required citation syntax such as [S2 p.19].",
          "- Every substantive paragraph or bullet must contain at least one valid citation.",
        ]
      : [
          "TARGETED REPAIR MODE:",
          "- Change only the sentences quoted under VALIDATION FAILURES; copy every other sentence unchanged, figures included.",
          "- uncited_numeric_claim: add, in the same sentence, the citation of the evidence page that states that figure.",
          "- unsupported_numeric_claim: the figure is not on the page cited. Cite the page that does state it, or replace only that figure with words (e.g. 'the prescribed percentage').",
          "- unsafe_numeric_claim: cite a page whose text states the figure clearly, or replace only that figure with words.",
          "- Never invent a figure; never drop a correct, cited figure.",
        ];

  return [
    "REPAIR THE DRAFT ANSWER.",
    "",
    "The draft failed deterministic citation/numeric-safety validation.",
    "Return ONLY the corrected final answer. Do not discuss the validation process.",
    "",
    "Requirements:",
    "- Keep factual claims grounded only in the supplied evidence.",
    "- Use valid inline citations in the exact form [S1 p.9].",
    "- Never invent a source label, page number, fact, or numeric value.",
    ...strictRules,
    "",
    "VALIDATION FAILURES:",
    issueText,
    "",
    "DRAFT ANSWER:",
    originalAnswer,
  ].join("\n");
}

/**
 * Last safe step before the generic fallback.
 *
 * A small local model can occasionally ignore strict repair instructions and leave
 * an uncited number behind. Instead of throwing away an otherwise useful answer,
 * retain only claim units that:
 *   1. contain no numeric token outside citation syntax;
 *   2. contain no internal mask placeholder; and
 *   3. already carry a valid supplied source/page citation.
 *
 * This does not invent or rewrite facts. It only removes unsafe claim units.
 */

const DEPENDENT_SALVAGE_START_RE =
  /^(?:this|that|these|those|it)\s+(?:is|are|was|were|will\s+be|would\s+be)\s+(?:also\s+)?(?:followed|continued|then)\b|^(?:after\s+that|thereafter|furthermore|moreover)\b/i;

function cleanSalvageUnit(
  unit: string,
): string {
  const cleaned = unit
    .replace(
      /^\s*(?:[-–—•*]+\s*)+/,
      "",
    )
    .trim();
  // An odd number of "**" means a bold run was cut in half: drop the markers.
  return (cleaned.match(/\*\*/g) ?? []).length % 2 === 1 ? cleaned.replace(/\*\*/g, "") : cleaned;
}

export function buildQualitativeSalvage(
  answer: string,
  evidence: RetrievalEvidence[],
  question = "",
): string {
  const named = namedNumbers(evidence, question);
  let wordedUnits = 0;
  const allowedCitations =
    new Set(
      evidence.map((item) =>
        citationKey(
          item.label,
          item.page_number,
        ),
      ),
    );

  const kept: string[] = [];
  const evidenceByKey = new Map(evidence.map((item) => [citationKey(item.label, item.page_number), item]));
  const units = claimUnitsByLine(answer);

  for (const [index, rawUnitEntry] of units.entries()) {
    const unit = withoutListMarker(rawUnitEntry.text);

    if (INTERNAL_PLACEHOLDER_RE.test(unit)) {
      continue;
    }

    const withoutCitations =
      stripCitations(unit);

    if ((withoutCitations.match(/[\p{L}\p{M}]+/gu) ?? []).length >= 3) wordedUnits++;

    // A figure stays when it is cited (here or later on its line) to a page
    // that prints it reliably; anything else with a number goes.
    if (
      hasNumericClaim(withoutCitations, named) &&
      numericUnitIssue(unit, unitCitationsWithLine(units, index), evidenceByKey, named)
    ) {
      continue;
    }

    const hasValidCitation =
      unitCitationsWithLine(units, index).some(
        (citation) =>
          allowedCitations.has(
            citationKey(
              citation.label,
              citation.pageNumber,
            ),
          ),
      );

    if (!hasValidCitation) {
      continue;
    }

    const cleaned =
      cleanSalvageUnit(
        unit,
      );

    // A kept unit must say something: at least a few words besides citations.
    if (
      (stripCitations(cleaned).match(/[\p{L}\p{M}]+/gu) ?? []).length < 3
    ) {
      continue;
    }

    if (
      !cleaned ||
      DEPENDENT_SALVAGE_START_RE.test(
        cleaned,
      )
    ) {
      continue;
    }

    kept.push(cleaned);
  }

  // A salvage that keeps a small fraction of the answer misleads more than it
  // helps ("Central Government Context:** These rules apply …" as the whole
  // answer, 3 Oct). Below 30% of the answer's sentences, give up; the caller
  // then repairs or falls back.
  if (kept.length === 0 || kept.length < Math.ceil(wordedUnits * 0.3)) {
    return "";
  }
  if (kept.length === 1) {
    return kept[0];
  }

  return kept
    .map(
      (item) =>
        `• ${item}`,
    )
    .join("\n")
    .trim();
}

// A closing "(Note: … masked … verify against the original …)" paragraph:
// internal plumbing the officer should not read (3 Oct eval). The source cards
// already mark pages whose numbers need checking.
const VERIFICATION_NOTE_START = /^[\s*_>]*(?:\(|\[)?\s*[*_]*\s*(?:note|nb|caution|disclaimer|नोट|टिप्पणी|ध्यान दें|सावधानी)\s*[:：-]/iu;
const VERIFICATION_NOTE_TOPIC = /mask|ocr|verif|extraction|original (?:source|page)|सत्याप|संघर्ष|मूल (?:स्रोत|पृष्ठ)|ओसीआर|छिपा/iu;

/**
 * Drop trailing note paragraphs about masking/OCR/verification. Keeps the
 * answer unchanged when that would leave no citation.
 */
export function stripVerificationNotes(answer: string): string {
  const paragraphs = answer.trimEnd().split(/\n\s*\n/);
  while (paragraphs.length > 1) {
    const last = paragraphs[paragraphs.length - 1];
    if (!VERIFICATION_NOTE_START.test(last) || !VERIFICATION_NOTE_TOPIC.test(last)) break;
    paragraphs.pop();
  }
  const stripped = paragraphs.join("\n\n").trimEnd();
  return /\[S\d+\s+p\.\d+\]/.test(stripped) ? stripped : answer;
}

export function buildConservativeFallback(
  evidence: RetrievalEvidence[],
  language: "en" | "hi" = "en",
): string {
  const hi = language === "hi";

  if (evidence.length === 0) {
    return hi
      ? "संग्रहित शासनादेशों में इस प्रश्न का उत्तर देने के लिए पर्याप्त साक्ष्य नहीं मिला।"
      : "I could not retrieve evidence sufficient to answer this question from the archived government-order corpus.";
  }

  const first = evidence[0];
  const citation = `[${first.label} p.${first.page_number}]`;

  // Plain and short: what was found and where to read it. No talk of
  // "safety checks"; an officer only needs the page.
  if (hi) {
    return [
      `इस विषय का आदेश मिला है, पर उसका जाँचा हुआ सारांश नहीं बन सका। संबंधित पृष्ठ यहाँ पढ़ें ${citation}।`,
      "नीचे स्रोत कार्ड से पूरा आदेश खुलेगा; तिथि, राशि या संख्या मूल पृष्ठ से ही लें।",
    ].join(" ");
  }

  return [
    `I found an order on this, but could not produce a checked summary of it. Read the page here ${citation}.`,
    "The source card below opens the full order; take dates, amounts and numbers from the original page.",
  ].join(" ");
}
