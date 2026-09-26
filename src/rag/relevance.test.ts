import assert from "node:assert/strict";
import { assessRelevance, isNoAnswer, noEvidenceMessage, toRelevance } from "./relevance.js";
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
assert.match(noEvidenceMessage("en", false), /could not find/);

console.log("relevance gate tests passed");
