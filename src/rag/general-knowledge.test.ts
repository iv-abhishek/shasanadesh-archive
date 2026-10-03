import assert from "node:assert/strict";
import {
  buildGeneralKnowledgeMessages,
  cleanGeneralKnowledgeAnswer,
  closestDocuments,
  closestDocumentsFooter,
} from "./general-knowledge.js";
import type { RetrievalEvidence } from "./types.js";

const page = (sourceId: string, title: string | null, role: "direct" | "neighbor" = "direct") =>
  ({ source_id: sourceId, document_title: title, retrieval_role: role, go_number: "57/18-2-2024", go_date: "26 Nov 2024" }) as RetrievalEvidence;

const closest = closestDocuments([page("a", "GeM GO"), page("a", "GeM GO"), page("b", null), page("c", "Works Manual", "neighbor"), page("d", "Civil Accounts Manual")]);
assert.deepEqual(closest.map((doc) => doc.title), ["GeM GO", "Civil Accounts Manual"]);
assert.match(closestDocumentsFooter(closest, "en"), /Closest documents in the archive/);
assert.equal(closestDocumentsFooter([], "hi"), "");

const messages = buildGeneralKnowledgeMessages("service bid experience clause in GFR", "en", closest);
assert.match(messages[0].content, /own knowledge/);
assert.match(messages[1].content, /Possibly related documents[\s\S]*GeM GO \(57\/18-2-2024, 26 Nov 2024\)/);

assert.equal(cleanGeneralKnowledgeAnswer("Rule 173 [S1 p.2] applies.\n\n\n\nNO_ANSWER_IN_EVIDENCE"), "Rule 173 applies.");
console.log("general-knowledge tests passed");
