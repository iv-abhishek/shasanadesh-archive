import assert from "node:assert/strict";
import { hasEvidenceFromDepartments } from "./relevance.js";
import { assessRelevance, isNoAnswer, isProseNonAnswer, noEvidenceMessage, toRelevance, withoutNoAnswerToken } from "./relevance.js";
import type { RetrievalEvidence } from "./types.js";

const page = (label: string, sourceId: string, pageNumber: number, score: number, extra: Partial<RetrievalEvidence> = {}) =>
  ({
    label,
    source_id: sourceId,
    page_number: pageNumber,
    rerank_score_raw: score,
    retrieval_role: "direct",
    ...extra,
  }) as RetrievalEvidence;

// Probabilities pass through; logits are squashed.
assert.deepEqual(toRelevance([0.9, 0.02]), [0.9, 0.02]);
const logits = toRelevance([3, -4]);
assert.ok(logits[0] > 0.95 && logits[1] < 0.02);

// Weak direct pages are dropped, with their neighbours; strong ones stay with theirs.
{
  const evidence = [
    page("S1", "a", 7, 0.8),
    page("S2", "b", 2, 0.03),
    page("S3", "a", 8, 0, { retrieval_role: "neighbor", anchor_page_number: 7 }),
    page("S4", "b", 3, 0, { retrieval_role: "neighbor", anchor_page_number: 2 }),
  ];
  const result = assessRelevance(evidence, 0.1);
  assert.deepEqual(result.kept.map((item) => item.label), ["S1", "S3"]);
  assert.equal(result.dropped, 2);
  assert.equal(result.best, 0.8);
}

// Nothing relevant: nothing kept, best reported.
{
  const result = assessRelevance([page("S1", "a", 1, -5), page("S2", "a", 2, -6)], 0.1);
  assert.equal(result.kept.length, 0);
  assert.ok(result.best < 0.01);
}

assert.ok(isNoAnswer("NO_ANSWER_IN_EVIDENCE"));
assert.ok(isNoAnswer("  NO_ANSWER_IN_EVIDENCE.\n"));
assert.ok(!isNoAnswer("The rule says X [S1 p.2]. ".repeat(10) + "NO_ANSWER_IN_EVIDENCE"));
assert.match(noEvidenceMessage("hi", true), /सभी विभागों/);
assert.ok(isNoAnswer("The provided evidence does not contain the clause.\n\n* The documents reference GFR rules [S2 p.103].\n\nNO_ANSWER_IN_EVIDENCE"));
assert.equal(withoutNoAnswerToken("The rule says X [S1 p.2].\n\nNO_ANSWER_IN_EVIDENCE"), "The rule says X [S1 p.2].");
assert.match(noEvidenceMessage("en", false), /could not find/);

// Own-department evidence: any spelling of the officer's departments counts;
// rulebook pages (no department, or Finance for the Handbook) do not.
{
  const page = (department: string | null) => ({ department } as unknown as Parameters<typeof hasEvidenceFromDepartments>[0][number]);
  const profile = ["शिक्षा विभाग", "कृषि विभाग", "लोक निर्माण विभाग"];
  assert.equal(hasEvidenceFromDepartments([page("वित्त विभाग"), page(null)], profile), false);
  assert.equal(hasEvidenceFromDepartments([page("Agriculture")], profile), true);
  assert.equal(hasEvidenceFromDepartments([page("लोक\u200d निर्माण विभाग")], profile), true);
  assert.equal(hasEvidenceFromDepartments([page("माध्यमिक शिक्षा विभाग")], profile), true);
}

console.log("relevance gate tests passed");

// "Not found" written as prose (baseline eval, 2 Oct 2026).
assert.ok(isProseNonAnswer("The provided evidence does not contain information about the procedure to obtain a driving licence in Delhi. The retrieved documents pertain to the Uttar Pradesh Motor Vehicles Rules and do not address the process for obtaining a driving licence in Delhi [S1 p.8]. Therefore, the procedures for obtaining a driving licence in Delhi are not established by the provided evidence."));
assert.ok(isProseNonAnswer("लखनऊ मेट्रो में एक यात्रा का किराया निर्धारित नहीं किया गया है। उत्तर प्रदेश सरकार के आदेशों में लखनऊ मेट्रो के यात्रा किराया के बारे में कोई जानकारी नहीं दी गई है [S1 p.1]। इसलिए, यात्रा किराया के बारे में कोई विशिष्ट जानकारी उपलब्ध नहीं है।"));
// A real answer with one "not specified" point is still an answer.
assert.equal(isProseNonAnswer("Maternity leave is 180 days [S1 p.2]. It may be taken twice in service [S1 p.2]. The order does not specify a separate rule for adoption [S1 p.3]."), false);
assert.equal(isProseNonAnswer("The order does not specify a time limit [S1 p.2]."), false);
assert.match(noEvidenceMessage("en", true), /Uttar Pradesh and Government of India/);
console.log("prose non-answer tests passed");

// Sources described instead of an answer (metro fare, 3 Oct evening eval).
assert.ok(isProseNonAnswer("उत्तर प्रदेश सरकार के द्वारा जारी शासन आदेशों में लखनऊ मेट्रो के यात्रा किराए के बारे में कोई जानकारी उपलब्ध नहीं है [S1 p.3], [S2 p.2], [S5 p.2]।\n\n* स्रोत S1 में केवल ई-रिक्शा के लिए अधिकतम किराया दर निर्धारित की गई है [S1 p.3]।\n* स्रोत S2 और S5 में सड़क सुरक्षा, शिक्षा संस्थानों के रोड सेफ्टी लैब के बारे में है [S2 p.2]।"));
// A cited answer that merely names a source label is still an answer.
assert.equal(isProseNonAnswer("* Leave is 180 days [S1 p.2].\n* It may be taken twice [S1 p.2].\n* Source S1 is the 2026 order [S1 p.1]."), false);
console.log("source-description tests passed");

// Describing the retrieved pages (3 Oct, consultancy manual eligibility).
assert.ok(isProseNonAnswer("* The retrieved page from the Manual for Procurement of Consultancy Services contains only model clauses regarding bidders from countries sharing a land border [S1 p.241].\n* The retrieved pages from the Manual for Procurement of Non-Consultancy Services outline eligibility criteria for that category, which is distinct from Consultancy Services [S2 p.63]."));
console.log("retrieved-page description tests passed");

// The rescue agent's "not found" answers (hybrid eval with reranker v1, 6 Oct):
// each was shown as an answer instead of the clean "not found".
assert.ok(isProseNonAnswer("यह जानकारी सरकारी वेबसाइटों की लाइव खोज पर आधारित है, न कि संग्रहीत आदेशों पर।\n\n- उपलब्ध पृष्ठ उत्तर प्रदेश फार्मेसी परिषद (UPPC) के पंजीकरण/सत्यापन से संबंधित हैं, न कि पासपोर्ट नवीनीकरण से [S1 p.1]।\n- इन पृष्ठों में पासपोर्ट नवीनीकरण की प्रक्रिया, आवेदन, शुल्क या आवश्यक दस्तावेजों के बारे में कोई जानकारी नहीं है [S1 p.1]।\n- पासपोर्ट नवीनीकरण की प्रक्रिया के बारे में प्रश्न का उत्तर इन साक्ष्यों में उपलब्ध नहीं है।"));
assert.ok(isProseNonAnswer("प्रस्तुत साक्ष्यों में लखनऊ मेट्रो के किराए का कोई उल्लेख नहीं है। उपलब्ध दस्तावेज़ निम्नलिखित विषयों से संबंधित हैं:\n\n- ई-रिक्शा (अनुबंधित परिवहन) के लिए अधिकतम किराया दर निर्धारण [S1 p.3]\n- निजी ऑपरेटरों और राज्य परिवहन उपक्रम के लिए स्टेज कैरिज मार्गों का अधिकार-क्षेत्र [S2 p.3]\n- उत्तर प्रदेश परिवहन सेवा नियम, 1990 में संशोधन [S3 p.4]\n- सरकारी कर्मचारियों के यात्रा भत्ते की दरें [S4 p.122]\n\nइनमें से किसी भी दस्तावेज़ में लखनऊ मेट्रो के किराए की जानकारी नहीं दी गई है।"));
assert.ok(isProseNonAnswer("Based on official government websites (not the archived orders), the retrieved page does not answer your question.\n\nThe only retrieved page is a draft notification from the Uttar Pradesh government proposing the \"Uttar Pradesh Motor Vehicles (Aggregator and Delivery Service Provider) Rules, 2026,\" which deals with aggregator and delivery service providers, not with the procedure for obtaining a driving licence [S1 p.1]. It is a draft rule, not a final one, and it concerns Uttar Pradesh, not Delhi [S1 p.1].\n\nThe procedure for getting a driving licence in Delhi is not established in the provided evidence."));
// Real answers that mention what a rule relates to stay answers.
assert.equal(isProseNonAnswer("यह आदेश सभी राज्य कर्मचारियों पर लागू है [S1 p.1]। मातृत्व अवकाश 180 दिन का है [S1 p.2]। यह दो बार लिया जा सकता है [S1 p.2]।"), false);
assert.equal(isProseNonAnswer("The order applies to all state employees [S1 p.1]. The limit is 300 days of earned leave [S1 p.2]. Encashment is allowed at retirement [S2 p.4]."), false);
console.log("rescue not-found tests passed");
