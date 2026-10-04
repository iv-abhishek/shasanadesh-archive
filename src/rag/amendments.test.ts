/** Amendment register (ADR-094). */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  amendmentPrompt,
  amendmentsFor,
  appendEvidence,
  cardAmendments,
  loadAmendments,
  missingPages,
  parseAmendment,
} from "./amendments.js";
import type { RetrievalEvidence } from "./types.js";

const entries = loadAmendments();
assert.ok(entries.length >= 1, "register has entries");
for (const entry of entries) {
  assert.ok(existsSync(path.join("datasets/amendments", `${entry.id}.md`)), `${entry.id}.md is named after its id`);
}
// Every page in the register exists in the corpus (when present).
if (existsSync("data/corpus/retrieval-pages.jsonl")) {
  const wanted = new Set(
    entries.flatMap((e) => [
      ...e.rulePages,
      ...e.currentPages,
      ...e.amendedBy.flatMap((o) => (o.page ? [o.page] : [])),
    ]).map((p) => `${p.sourceId}#${p.pageNumber}`),
  );
  const found = new Set<string>();
  for (const line of readFileSync("data/corpus/retrieval-pages.jsonl", "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line) as { sourceId: string; pageNumber: number };
    const id = `${row.sourceId}#${row.pageNumber}`;
    if (wanted.has(id)) found.add(id);
  }
  for (const id of wanted) assert.ok(found.has(id), `register page ${id} is in the corpus`);
}

const ev = (source_id: string, page_number: number, label = "S1") =>
  ({ source_id, page_number, label }) as unknown as RetrievalEvidence;

const maternity = entries.find((e) => e.id === "fhb-sr-153-maternity-leave")!;
assert.ok(maternity);
// The printed rule pulls in the current position; the current position pulls in the printed rule.
assert.deepEqual(amendmentsFor([ev("up-fhb-vol2", 183)]).map((e) => e.id), [maternity.id]);
assert.deepEqual(amendmentsFor([ev("core-rules-up-vitta-path-09-leave-rules", 9)]).map((e) => e.id), [maternity.id]);
assert.deepEqual(amendmentsFor([ev("up-fhb-vol2", 90)]), []);
// Earned leave: the printed rule, the 1992 amendment printed in the same book, and the current page.
assert.deepEqual(amendmentsFor([ev("up-fhb-vol2", 302)]).map((e) => e.id), ["fr-81b-earned-leave-limit"]);
assert.deepEqual(amendmentsFor([ev("core-rules-up-vitta-path-09-leave-rules", 4)]).map((e) => e.id), ["fr-81b-earned-leave-limit"]);
const el = entries.find((e) => e.id === "fr-81b-earned-leave-limit")!;
assert.deepEqual(
  cardAmendments([el], "en").get("up-fhb-vol2")?.map((n) => n.direction),
  ["amended_by", "amended_by"],
  "the rulebook's own corrigenda page is not marked as a separate amending order",
);
assert.deepEqual(
  missingPages([maternity], [ev("up-fhb-vol2", 183)]).map((p) => `${p.sourceId} p.${p.pageNumber}`),
  ["core-rules-up-vitta-path-09-leave-rules p.9", "core-rules-up-vitta-path-09-leave-rules p.10"],
);

const evidence = appendEvidence(
  [ev("a", 1, "S1"), ev("up-fhb-vol2", 183, "S2")],
  [ev("core-rules-up-vitta-path-09-leave-rules", 9, "S1"), ev("up-fhb-vol2", 183, "S2")],
);
assert.deepEqual(evidence.map((e) => `${e.label}:${e.source_id}:${e.page_number}`), [
  "S1:a:1",
  "S2:up-fhb-vol2:183",
  "S3:core-rules-up-vitta-path-09-leave-rules:9",
]);

const prompt = amendmentPrompt([maternity], evidence, "en");
assert.match(prompt, /Printed text \(may be out of date\): S2 p\.183/);
assert.match(prompt, /Current position stated on: S3 p\.9/);
assert.match(prompt, /Amended by GO G-4-484\/X-90-216-79 dated 03\.05\.1990/);
assert.match(prompt, /GO not in the archive; name it, do not cite it/);
assert.match(prompt, /Never present the printed text as current/);
assert.equal(amendmentPrompt([], evidence, "en"), "");

const cards = cardAmendments([maternity], "hi");
assert.equal(cards.get("up-fhb-vol2")?.[0].direction, "amended_by");
assert.match(cards.get("up-fhb-vol2")![0].rule, /सहायक नियम 153/);
assert.equal(cards.has("core-rules-up-vitta-path-09-leave-rules"), false, "a compilation is not marked amended");

// An archived amending GO is marked on its own card too.
const withGo = parseAmendment(
  "---\nid: x\nrule: Rule X\nrule_pages:\n  - book p.5\namended_by:\n  - 12/2024 | 2024-04-01 | 7#1#2#2024 p.1 | period raised\n---\n",
);
const goCards = cardAmendments([withGo], "en");
assert.equal(goCards.get("7#1#2#2024")?.[0].direction, "amends");
assert.equal(goCards.get("book")?.[0].goSourceId, "7#1#2#2024");
assert.deepEqual(amendmentsFor([ev("7#1#2#2024", 3)], [withGo]).map((e) => e.id), ["x"], "any page of the GO links it");

assert.throws(() => parseAmendment("---\nid: x\nrule: R\nrule_pages:\n  - b p.1\n---\n"), /amended_by/);
assert.throws(() => parseAmendment("---\nid: x\nrule: R\nrule_pages:\n  - b p.1\namended_by:\n  - 1/2020 | 1.1.2020 | |\n---\n"), /YYYY-MM-DD/);

console.log(`amendment register tests passed (${entries.length} entries)`);

// Question triggers bring an entry in even when the search found other pages.
{
  const found = amendmentsFor([ev("up-fhb-vol2", 304)], undefined, "maximum earned leave that can be accumulated");
  assert.deepEqual(found.map((e) => e.id), ["fr-81b-earned-leave-limit"]);
  assert.deepEqual(amendmentsFor([ev("x", 1)], undefined, "earned leave encashment procedure").map((e) => e.id), [], "earned leave alone is not the limit");
  assert.deepEqual(amendmentsFor([ev("x", 1)], undefined, "महिला कर्मचारी को प्रसूति अवकाश कितने दिन").map((e) => e.id), ["fhb-sr-153-maternity-leave"]);
  console.log("amendment trigger tests passed");
}
