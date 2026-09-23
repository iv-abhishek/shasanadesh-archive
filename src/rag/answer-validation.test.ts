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

console.log(
  "answer-validation tests passed",
);
