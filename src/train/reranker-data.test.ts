import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { groupOf, parseQuestions, rerankInstruction, samplePages, sharedWords, usablePage } from "./reranker-data.js";

assert.equal(groupOf("core-rules-gfr-2017"), "rulebook");
assert.equal(groupOf("232#171#4#2021"), "order");
assert.equal(groupOf("crawl-uplc-gos-abc"), "other");
assert.ok(!usablePage("1 2 3 4 5 ".repeat(80)));
assert.ok(usablePage("उत्तर प्रदेश शासन के समस्त विभागों को निर्देशित किया जाता है ".repeat(10)));

const page = (sourceId: string, n: number) => ({ variantId: `${sourceId}:p${n}`, sourceId, pageNumber: n, text: "x" });
const pages = [...Array.from({ length: 20 }, (_, i) => page("core-rules-gfr", i + 1)), ...Array.from({ length: 50 }, (_, i) => page(`${i}#1#1#2020`, 1))];
const sample = samplePages(pages, 20, new Set(["0#1#1#2020"]));
assert.ok(sample.filter((p) => p.sourceId === "core-rules-gfr").length <= 8, "at most 8 pages of one rulebook");
assert.ok(!sample.some((p) => p.sourceId === "0#1#1#2020"), "eval documents left out");
assert.deepEqual(samplePages(pages, 20, new Set()).map((p) => p.variantId), samplePages(pages, 20, new Set()).map((p) => p.variantId), "deterministic");

assert.deepEqual(parseQuestions('{"skip": true}'), { skip: true, questions: [] });
const parsed = parseQuestions('```json\n{"skip": false, "questions": [{"q": "What is the EMD for GeM bids?", "lang": "en", "style": "question"}, {"q": "x", "lang": "hi"}]}\n```');
assert.equal(parsed?.questions.length, 1);
assert.equal(parseQuestions("not json"), null);
assert.ok(sharedWords("maternity leave 180 days rule", "maternity leave rule 180 days") > 0.9);

const instruction = rerankInstruction(readFileSync("services/retrieval_server.py", "utf8"));
assert.match(instruction, /^Given a Hindi or English question about Uttar Pradesh government orders, rank passages/);
assert.ok(!instruction.includes('"'));
console.log("reranker data tests passed");

import { splitPages } from "./ocr-batch.js";
const split = splitPages("\n\n===== PAGE 1 =====\n\nपहला पृष्ठ\n\n\n===== PAGE 2 =====\n\nदूसरा\n");
assert.equal(split.size, 2);
assert.equal(split.get(2), "दूसरा");
console.log("ocr batch tests passed");
