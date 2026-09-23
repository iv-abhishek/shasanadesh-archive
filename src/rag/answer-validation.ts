import type { RetrievalEvidence } from "./types.js";

export type AnswerValidationIssueCode =
  | "empty_answer"
  | "missing_citation"
  | "invalid_citation"
  | "uncited_numeric_claim"
  | "unsafe_numeric_claim"
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

const CAUTION_RE =
  /\b(?:unverified|not verified|verify|verification|ocr|source page|original page|check against|needs checking)\b|(?:असत्यापित|सत्यापन|सत्यापित नहीं|मूल पृष्ठ|मूल पेज|जाँच|जांच|पुष्टि)/i;

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

function claimUnits(text: string): string[] {
  return text
    .split(/(?<=[.!?।])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function validateAnswer(
  answer: string,
  evidence: RetrievalEvidence[],
): AnswerValidationResult {
  const issues: AnswerValidationIssue[] = [];
  const trimmed = answer.trim();

  if (!trimmed) {
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

  for (const unit of claimUnits(trimmed)) {
    const withoutCitations =
      stripCitations(unit);

    if (!NUMERIC_TOKEN_RE.test(withoutCitations)) {
      NUMERIC_TOKEN_RE.lastIndex = 0;
      continue;
    }

    NUMERIC_TOKEN_RE.lastIndex = 0;

    const unitCitations =
      extractCitations(unit);

    if (unitCitations.length === 0) {
      issues.push({
        code: "uncited_numeric_claim",
        message:
          "A numeric claim must have a source-page citation in the same sentence or line.",
        excerpt: unit.slice(0, 240),
      });

      continue;
    }

    const citedEvidence =
      unitCitations
        .map((citation) =>
          evidenceByKey.get(
            citationKey(
              citation.label,
              citation.pageNumber,
            ),
          ),
        )
        .filter(
          (
            item,
          ): item is RetrievalEvidence =>
            Boolean(item),
        );

    const hasSafeNumericSource =
      citedEvidence.some(
        (item) =>
          !isRiskyNumericEvidence(item),
      );

    const allNumericSourcesRisky =
      citedEvidence.length > 0 &&
      !hasSafeNumericSource;

    if (
      allNumericSourcesRisky &&
      !CAUTION_RE.test(unit)
    ) {
      issues.push({
        code: "unsafe_numeric_claim",
        message:
          "A numeric claim relies only on OCR-conflicted or OCR-only-unverified evidence and is stated without an explicit source-page verification warning.",
        excerpt: unit.slice(0, 240),
      });
    }
  }

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

  const strictQualitativeMode =
    validation.issues.some(
      (issue) =>
        issue.code === "unsafe_numeric_claim" ||
        issue.code === "uncited_numeric_claim" ||
        issue.code === "internal_placeholder",
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
          "NORMAL REPAIR MODE:",
          "- Keep a numeric claim only when it has a valid same-sentence citation and satisfies the evidence-status rules.",
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
export function buildQualitativeSalvage(
  answer: string,
  evidence: RetrievalEvidence[],
): string {
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

  for (const unit of claimUnits(answer)) {
    if (INTERNAL_PLACEHOLDER_RE.test(unit)) {
      continue;
    }

    const withoutCitations =
      stripCitations(unit);

    const containsNumeric =
      NUMERIC_TOKEN_RE.test(
        withoutCitations,
      );

    NUMERIC_TOKEN_RE.lastIndex = 0;

    if (containsNumeric) {
      continue;
    }

    const hasValidCitation =
      extractCitations(unit).some(
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

    kept.push(unit);
  }

  return kept.join(" ").trim();
}

export function buildConservativeFallback(
  evidence: RetrievalEvidence[],
): string {
  if (evidence.length === 0) {
    return (
      "I could not retrieve evidence sufficient to answer this question from the archived government-order corpus."
    );
  }

  const first = evidence[0];

  return [
    "Relevant government-order evidence was retrieved, but a fully generated answer did not pass the citation and numeric-verification safety checks.",
    `Please review the original source page directly [${first.label} p.${first.page_number}].`,
    "Any critical date, amount, percentage, rule number, level, Government Order number, or identifier from OCR-only or conflicting extraction should be verified against the original page before it is relied upon.",
  ].join(" ");
}
