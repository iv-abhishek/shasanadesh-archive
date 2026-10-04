import assert from "node:assert/strict";
import { stripVerificationNotes,
  addMissingCitations,
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

// A citation after the full stop belongs to that sentence (26 Sept, Hindi).
{
  const hindi = [
    "- शासनादेश के अंतर्गत बाउण्ड्रीवाल के निर्माण के लिए वित्तीय स्वीकृति दी गई है। [S1 p.1]",
    "- कार्य की गुणवत्ता की जिम्मेदारी कार्यदायी संस्था की होगी। [S1 p.1]",
  ].join("\n");
  assert.equal(validateAnswer(hindi, riskyEvidence).ok, true);
}

// Salvage never returns citation-only bullets. The numeric sentences are
// dropped; the qualitative one keeps its trailing citation.
{
  const draft = [
    "- कुल 75 जनपदों के विद्यालयों हेतु धनराशि स्वीकृत की गई है। [S1 p.1]",
    "- कार्य की गुणवत्ता की जिम्मेदारी कार्यदायी संस्था की होगी। [S1 p.1]",
    "- धनराशि का 50 प्रतिशत प्रथम किश्त में दिया जायेगा। [S1 p.1]",
  ].join("\n");
  const salvage = buildQualitativeSalvage(draft, riskyEvidence);
  assert.equal(salvage, "कार्य की गुणवत्ता की जिम्मेदारी कार्यदायी संस्था की होगी। [S1 p.1]");
}

// An "answer" of only citations is empty.
{
  const result = validateAnswer("• [S1 p.1]\n• [S1 p.1]", riskyEvidence);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "empty_answer");
}

console.log(
  "answer-validation tests passed",
);

// Trailing "(Note: … masked … verify …)" paragraphs are dropped (3 Oct eval).
{
  const en = "* Seniority is fixed on substantive appointment [S1 p.18].\n\n*(Note: The exact rule numbers are masked in the evidence and require verification against the original source.)*";
  assert.equal(stripVerificationNotes(en), "* Seniority is fixed on substantive appointment [S1 p.18].");
  const hi = "* सत्यापन जिला स्तर पर होगा [S3 p.7]।\n\n*(नोट: कुछ संख्यात्मक मानक OCR संघर्ष के कारण सत्यापित नहीं हैं और मूल स्रोत पृष्ठ से सत्यापित करने की आवश्यकता है [S3 p.7]।)*";
  assert.equal(stripVerificationNotes(hi), "* सत्यापन जिला स्तर पर होगा [S3 p.7]।");
  // A note about the subject itself stays; so does an answer that would lose its only citation.
  const real = "* Leave is 180 days [S1 p.2].\n\nNote: the order applies to all women employees [S1 p.2].";
  assert.equal(stripVerificationNotes(real), real);
  const only = "Intro.\n\n(Note: numbers masked; verify on the original page [S1 p.1].)";
  assert.equal(stripVerificationNotes(only), only);
  console.log("verification-note tests passed");
}

// 3 Oct: document names with years are not numeric claims; a salvage that
// keeps a sliver of the answer is not used.
{
  const manual = { ...riskyEvidence[0], document_title: "Manual for Procurement of Consultancy Services, Second Edition 2025" };
  const answer = "The Manual for Procurement of Consultancy Services 2025 asks for experience of similar assignments [S1 p.1]. GFR 2017 requires fair and transparent criteria [S1 p.1].";
  assert.equal(validateAnswer(answer, [manual], "suggest GFR 2017 guidelines for a service bid").ok, true);
  const draft = [
    "**Central Government Context:** These rules apply to central entities [S1 p.1].",
    "- Bidders need 3 similar works of 40% value [S1 p.1].",
    "- Bidders need 2 similar works of 50% value [S1 p.1].",
    "- Bidders need 1 similar work of 80% value [S1 p.1].",
    "- Turnover must be 30% of the estimate [S1 p.1].",
  ].join("\n");
  assert.equal(buildQualitativeSalvage(draft, riskyEvidence), "");
  // An odd "**" left by a cut bold run is removed.
  assert.ok(!buildQualitativeSalvage("**Context:** The rules apply to central entities [S1 p.1].\n**Scope** They cover all services [S1 p.1].", riskyEvidence).includes("*"));
  console.log("named-number and salvage-floor tests passed");
}

// 4 Oct: line-level citations, variant agreement, and salvage keeping valid figures.
{
  const validate = validateAnswer;
  const salvage = buildQualitativeSalvage;
  const page = (label: string, page_number: number, text: string, extra: Record<string, unknown> = {}) =>
    ({
      label,
      page_number,
      source_id: `doc-${label}`,
      selected_page_text: text,
      canonical_page_text: text,
      numeric_verification_status: "native_primary",
      ...extra,
    }) as never;
  const works = page("S1", 132, "mobilisation advance at 10 (ten) per cent of the contract price, interest-bearing");
  // A bullet whose citation comes after its second sentence covers the first.
  const twoSentences = validate("• Mobilisation advance is 10 per cent of the contract price. It is interest-bearing [S1 p.132].", [works]);
  if (!twoSentences.ok) throw new Error(`line citation should cover the bullet: ${JSON.stringify(twoSentences.issues)}`);
  // A conflict page is still reliable for numbers that both extractions print.
  const gem = page("S2", 14, "टनओवर 30% (तीस तशत) 2017/", {
    numeric_verification_status: "conflict",
    other_variant_texts: ["टर्नओवर 30% (तीस प्रतिशत) 207/"],
  });
  if (!validate("Average turnover must be at least 30% of the estimated cost [S2 p.14].", [gem]).ok)
    throw new Error("numbers agreed by both extractions should pass");
  if (validate("The rule dates from 2017 [S2 p.14].", [gem]).ok) throw new Error("a number read differently must still fail");
  // Salvage keeps a valid cited figure and drops the unsupported one.
  const kept = salvage(
    "• Mobilisation advance is 10 per cent of the contract price [S1 p.132].\n• It is recovered in 7 instalments [S1 p.132].\n• It is given for capital-intensive works [S1 p.132].",
    [works],
  );
  if (!kept.includes("10 per cent") || kept.includes("7 instalments")) throw new Error(`salvage should keep 10% and drop 7: ${kept}`);
  console.log("line-citation, variant-agreement and figure-keeping salvage tests passed");
}

// ADR-098: a figure cited to the wrong page gets the page that prints it.
{
  const page = (label: string, page_number: number, text: string) =>
    ({ label, page_number, source_id: `doc-${label}`, selected_page_text: text, canonical_page_text: text, numeric_verification_status: "native_primary" }) as never;
  const s1 = page("S1", 3, "Purchase of goods without quotation: general conditions for the purchase committee and the buyer.");
  const s2 = page("S2", 155, "Purchase of goods without quotation up to the value of Rs 50,000 on each occasion may be made by the competent authority.");
  const wrong = "• Goods may be purchased without quotation up to Rs 50,000 on each occasion [S1 p.3].";
  const fixed = addMissingCitations(wrong, [s1, s2]);
  if (fixed.added !== 1 || !fixed.answer.includes("[S2 p.155]")) throw new Error(`should add S2: ${fixed.answer}`);
  if (!validateAnswer(fixed.answer, [s1, s2]).ok) throw new Error("re-cited answer should validate");
  // A figure on no page stays as it is (left for the repair).
  const invented = "• The limit is Rs 75,000 for each purchase of goods without quotation [S1 p.3].";
  if (addMissingCitations(invented, [s1, s2]).added !== 0) throw new Error("must not cite a page without the figure");
  // Too few shared words: no citation added.
  const unrelated = "• Fees are Rs 50,000 [S1 p.3].";
  if (addMissingCitations(unrelated, [s1, s2]).added !== 0) throw new Error("needs at least 3 shared words");
  console.log("citation correction tests passed");
}
