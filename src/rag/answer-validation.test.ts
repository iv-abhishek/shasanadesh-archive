import assert from "node:assert/strict";
import {
  buildQualitativeSalvage,
  validateAnswer,
} from "./answer-validation.js";

const base = {
  source_id: "x",
  department: "Test",
  go_number: null,
  go_date: null,
  source_url: "https://example.invalid/doc",
  page_url: "https://example.invalid/doc#page=1",
  selected_variant: "native",
  selected_canonical: true,
  numeric_conflict: false,
  selected_page_text: "example",
  canonical_page_text: "example",
  rerank_score_raw: 1,
};

const safeEvidence = [
  {
    ...base,
    label: "S1",
    page_number: 1,
    selected_page_text: "These rules of 1991 apply. Amount Rs. 50,000.",
    canonical_page_text: "These rules of 1991 apply. Amount Rs. 50,000.",
    numeric_verification_status:
      "native_primary",
  },
] as any;

const riskyEvidence = [
  {
    ...base,
    label: "S1",
    page_number: 1,
    selected_variant: "ocr",
    numeric_verification_status:
      "ocr_only_unverified",
  },
] as any;

assert.equal(
  validateAnswer(
    "The rule applies to these officers [S1 p.1].",
    safeEvidence,
  ).ok,
  true,
);

assert.equal(
  validateAnswer(
    "The rule applies to these officers.",
    safeEvidence,
  ).ok,
  false,
);

assert.equal(
  validateAnswer(
    "The rule dates from 1991 [S1 p.1].",
    riskyEvidence,
  ).ok,
  false,
);

assert.equal(
  validateAnswer(
    "The OCR text appears to show 1991, but that year is unverified and requires checking against the original source page [S1 p.1].",
    riskyEvidence,
  ).ok,
  true,
);

assert.equal(
  validateAnswer(
    "The rule dates from 1991.",
    safeEvidence,
  ).ok,
  false,
);

assert.equal(
  validateAnswer(
    "The rule dates from 1991 [S1 p.1].",
    safeEvidence,
  ).ok,
  true,
);

assert.equal(
  validateAnswer(
    "The rule applies [S9 p.99].",
    safeEvidence,
  ).ok,
  false,
);


assert.equal(
  validateAnswer(
    "The relevant grade is [UNVERIFIED_NUMERIC] [S1 p.1].",
    riskyEvidence,
  ).ok,
  false,
);

const placeholderValidation =
  validateAnswer(
    "The relevant grade is [UNVERIFIED_NUMERIC] [S1 p.1].",
    riskyEvidence,
  );

assert.equal(
  placeholderValidation.issues.some(
    (issue) =>
      issue.code === "internal_placeholder",
  ),
  true,
);


const qualitativeSalvage =
  buildQualitativeSalvage(
    [
      "The order describes seniority for the relevant cadre [S1 p.1].",
      "It mentions 20 posts [S1 p.1].",
      "This uncited sentence should also be removed.",
    ].join(" "),
    riskyEvidence,
  );

assert.equal(
  qualitativeSalvage,
  "The order describes seniority for the relevant cadre [S1 p.1].",
);

assert.equal(
  validateAnswer(
    qualitativeSalvage,
    riskyEvidence,
  ).ok,
  true,
);


const formattedQualitativeSalvage =
  buildQualitativeSalvage(
    [
      "This is followed by other members [S1 p.1].",
      "- The order describes seniority for the relevant cadre [S1 p.1].",
      "- The appointing authority follows the relevant list [S1 p.1].",
    ].join(" "),
    riskyEvidence,
  );

assert.equal(
  formattedQualitativeSalvage,
  [
    "\u2022 The order describes seniority for the relevant cadre [S1 p.1].",
    "\u2022 The appointing authority follows the relevant list [S1 p.1].",
  ].join("\n"),
);

assert.equal(
  validateAnswer(
    formattedQualitativeSalvage,
    riskyEvidence,
  ).ok,
  true,
);

// A number must actually appear on a reliable cited page.
{
  const result = validateAnswer(
    "The rule dates from 1995 [S1 p.1].",
    safeEvidence,
  );
  assert.equal(result.ok, false);
  assert.equal(
    result.issues.some((issue) => issue.code === "unsupported_numeric_claim"),
    true,
  );
}

// Devanagari digits and thousands separators still match the page.
assert.equal(
  validateAnswer("राशि ५०,००० रुपये है [S1 p.1]।", safeEvidence).ok,
  true,
);
assert.equal(
  validateAnswer("The amount is Rs. 50000 [S1 p.1].", safeEvidence).ok,
  true,
);

// Citing a safe page alongside a risky one does not launder a risky number.
{
  const mixed = [
    ...safeEvidence,
    {
      ...base,
      label: "S2",
      page_number: 2,
      selected_variant: "ocr",
      selected_page_text: "Level 11 applies.",
      canonical_page_text: "Level 11 applies.",
      numeric_verification_status: "ocr_only_unverified",
    },
  ] as any;
  assert.equal(
    validateAnswer("The officer moves to level 11 [S1 p.1] [S2 p.2].", mixed).ok,
    false,
  );
  assert.equal(
    validateAnswer(
      "The OCR text shows level 11, which is unverified and must be checked against the cited page [S2 p.2].",
      mixed,
    ).ok,
    true,
  );
}

// Mentioning OCR or "verification" is not by itself a caution.
assert.equal(
  validateAnswer(
    "Character verification is required within 30 days as per OCR text [S1 p.1].",
    riskyEvidence,
  ).ok,
  false,
);

// List numbering is formatting, not a numeric claim.
assert.equal(
  validateAnswer(
    "1. The rules apply to these officers [S1 p.1].\n2. The appointing authority decides [S1 p.1].",
    riskyEvidence,
  ).ok,
  true,
);

console.log(
  "answer-validation tests passed",
);
