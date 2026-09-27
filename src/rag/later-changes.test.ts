import assert from "node:assert/strict";
import { findLaterChanges, laterChangesPromptLine } from "./later-changes.js";
import { buildEvidenceContext } from "./prompt.js";
import type { RetrievalEvidence } from "./types.js";

const evidence = (label: string, sourceId: string, goNumber: string | null, goDate: string | null) =>
  ({
    label, source_id: sourceId, page_number: 1, department: null, go_number: goNumber, go_date: goDate,
    source_url: "", page_url: "", selected_variant: "native", selected_canonical: true, numeric_conflict: false,
    numeric_verification_status: "native_primary", rerank_score_raw: 1, fused_score: 1, matched_chunk_text: "",
    selected_page_text: "text", canonical_page_text: "text",
  }) as RetrievalEvidence;

async function main(): Promise<void> {
const rows = [
  { target: "old", source_id: "new1", kind: "refers", source_go_number: "5/2026", source_go_date: "2026-08-01" },
  { target: "old", source_id: "new2", kind: "amends", source_go_number: "9/2026", source_go_date: "2026-07-01" },
  { target: "old", source_id: "new2", kind: "supersedes", source_go_number: "9/2026", source_go_date: "2026-07-01" },
  { target: "old", source_id: "new3", kind: "corrects", source_go_number: null, source_go_date: null },
];

// Query parameters: one entry per order, number key + ISO date; rows merge per changing order,
// the stronger kind wins, and stronger kinds sort first.
{
  let params: unknown[] = [];
  const pool = { query: async (_sql: string, values: unknown[]) => { params = values; return { rows: rows.filter((r) => r.kind !== "refers") }; } };
  const found = await findLaterChanges(pool as never, [
    evidence("S1", "old", "160/दस-2012-216/79", "02/03/2012"),
    evidence("S2", "old", "160/दस-2012-216/79", "02/03/2012"),
    evidence("S3", "new2", null, null),
  ]);
  assert.deepEqual(params, [["old", "new2"], ["160/2012", ""], ["2012-03-02", ""]]);
  assert.deepEqual(found.get("old")?.map((c) => `${c.bySourceId}:${c.kind}`), ["new2:supersedes", "new3:corrects"]);

  // Prompt line: digit-free; a changing order in the evidence is named by its label.
  const labels = new Map([["old", "S1"], ["new2", "S3"]]);
  const line = laterChangesPromptLine(found.get("old"), labels);
  assert.equal(line, "superseded by SOURCE S3; corrected by a later order that is not in this evidence");
  assert.doesNotMatch((line ?? "").replace(/SOURCE S\d+/g, ""), /\d/); // labels are citation syntax
  assert.equal(laterChangesPromptLine(undefined, labels), null);

  const context = buildEvidenceContext([evidence("S1", "old", null, null), evidence("S3", "new2", null, null)], found);
  assert.match(context, /SOURCE S1[\s\S]*LATER_CHANGES=superseded by SOURCE S3/);
  assert.equal((context.match(/LATER_CHANGES=/g) ?? []).length, 1);
}

// Missing table (migration 008 not applied): no links, no error.
{
  const pool = { query: async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); } };
  assert.equal((await findLaterChanges(pool as never, [evidence("S1", "a", null, null)])).size, 0);
}

// Any other database error is reported to the caller (the API logs it and answers anyway).
{
  const pool = { query: async () => { throw new Error("connection refused"); } };
  await assert.rejects(findLaterChanges(pool as never, [evidence("S1", "a", null, null)]));
}

console.log("later-changes tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
