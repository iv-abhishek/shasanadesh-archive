/** Research agent loop (ADR-102) with a scripted model and fake tools. */
import assert from "node:assert/strict";
import { asStrings, parseRef, research, type AgentMessage, type ResearchDeps, type ToolCall } from "./research.js";
import type { RetrievalEvidence } from "../rag/types.js";

const page = (source_id: string, page_number: number, score = 0.9, text = "rule text"): RetrievalEvidence =>
  ({
    label: "x",
    source_id,
    page_number,
    document_title: `Doc ${source_id}`,
    department: null,
    go_number: null,
    go_date: null,
    source_url: "https://example.gov.in",
    page_url: "https://example.gov.in",
    selected_variant: "native",
    selected_canonical: true,
    numeric_conflict: false,
    rerank_score_raw: score,
    fused_score: score,
    matched_chunk_text: text,
    selected_page_text: text,
    canonical_page_text: text,
  }) as RetrievalEvidence;

const call = (id: string, name: string, args: unknown): ToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

function scripted(turns: ToolCall[][]): ResearchDeps["callModel"] {
  let i = 0;
  return async () => ({ role: "assistant", content: null, tool_calls: turns[i++] ?? [] }) as AgentMessage;
}

async function main() {
  const statuses: string[] = [];
  const searches: Array<{ q: string; scope: string; sources?: string[] }> = [];
  const deps: ResearchDeps = {
    search: async (q, o) => {
      searches.push({ q, scope: o.scope, sources: o.sources });
      return q.includes("GTC") ? [page("gtc", 19, 0.95)] : [page("gfr", 42, 0.8), page("gfr", 43, 0.4)];
    },
    openPages: async (_q, refs) => refs.map((r) => page(r.sourceId, r.pageNumber, 0.7)),
    findOrders: async () => [{ sourceId: "12#3#4#2024", title: "KGMU superannuation", goNumber: "1/2024", goDate: "2024-01-01", department: "Medical Education", indexed: true }],
    changes: async (pages) => pages.map((p) => `${p.source_id}: amended by GO 5/2025`),
    callModel: scripted([
      [call("a", "search_pages", { query: "EMD exemption PSU GeM GTC", scope: "procurement", sources: ["GeM GTC"] }), call("b", "search_pages", { query: "bid security GFR" })],
      [call("c", "open_pages", { refs: ["gfr p.44", "P2"] }), call("d", "check_changes", { tags: ["P1"] })],
      [call("e", "finish", { pages: ["P1", "P2", "P9"], answerable: true, note: "GTC lists PSUs" })],
    ]),
    onStatus: (s) => statuses.push(s),
  };
  const result = await research({ question: "Are PSUs exempt from EMD on GeM?", language: "en", today: "2026-10-04", hints: [], rulebookNames: ["GeM GTC", "GFR 2017"] }, deps);
  assert.equal(result.stoppedBy, "finish");
  assert.equal(result.steps, 3);
  assert.deepEqual(result.evidence.map((e) => `${e.label} ${e.source_id} p.${e.page_number}`), ["S1 gtc p.19", "S2 gfr p.42"], "unknown tag P9 ignored, labels renumbered");
  assert.equal(result.answerable, true);
  assert.equal(result.note, "GTC lists PSUs");
  assert.deepEqual(searches.map((s) => s.scope), ["procurement", "all"]);
  assert.deepEqual(searches[0].sources, ["GeM GTC"]);
  assert.deepEqual(result.trace.map((t) => t.tool), ["search_pages", "search_pages", "open_pages", "check_changes", "finish"]);
  assert.equal(result.trace[2].found, 2, "gfr p.44 and P2 (gfr p.42) opened");
  assert.ok(statuses[0].startsWith("Searching: EMD exemption"));

  // No finish: the best pages seen are used; the step limit stops the loop.
  const loop = await research(
    { question: "q", language: "hi", today: "2026-10-04", hints: [], rulebookNames: [] },
    { ...deps, callModel: async () => ({ role: "assistant", content: null, tool_calls: [call(String(Math.random()), "search_pages", { query: "x" })] }) },
    { maxSteps: 3, maxToolCalls: 10, maxMs: 60_000, maxFinalPages: 1 },
  );
  assert.equal(loop.stoppedBy, "steps");
  assert.deepEqual(loop.evidence.map((e) => `${e.source_id} p.${e.page_number}`), ["gfr p.42"], "highest score kept");

  // A model that answers without tools ends research with nothing chosen.
  const none = await research(
    { question: "q", language: "en", today: "2026-10-04", hints: [], rulebookNames: [] },
    { ...deps, callModel: async () => ({ role: "assistant", content: "I think…" }) },
  );
  assert.equal(none.stoppedBy, "no_tool_call");
  assert.equal(none.evidence.length, 0);

  // Tool failures are reported to the model, not thrown.
  const failing = await research(
    { question: "q", language: "en", today: "2026-10-04", hints: [], rulebookNames: [] },
    {
      ...deps,
      search: async () => {
        throw new Error("service down");
      },
      callModel: scripted([[call("a", "search_pages", { query: "x" })], [call("b", "finish", { pages: [], answerable: false })]]),
    },
  );
  assert.equal(failing.trace[0].error, "service down");
  assert.equal(failing.answerable, false);
  assert.equal(failing.evidence.length, 0, "answerable=false with no pages chooses nothing");

  // Preloaded playbook pages are visible from the start.
  const pre = await research(
    { question: "q", language: "en", today: "2026-10-04", hints: [], rulebookNames: [], preloaded: [page("pb", 30)] },
    { ...deps, callModel: scripted([[call("a", "finish", { pages: ["P1"], answerable: true })]]) },
  );
  assert.deepEqual(pre.evidence.map((e) => e.source_id), ["pb"]);

  assert.deepEqual(asStrings('["P1", "P2"]'), ["P1", "P2"]);
  assert.deepEqual(asStrings("P1, P2"), ["P1", "P2"]);
  assert.deepEqual(asStrings(["P1", 3, " "]), ["P1"]);
  assert.deepEqual(parseRef("P3"), { tag: "P3" });
  assert.deepEqual(parseRef("core-rules-gfr-2017 p.43"), { page: { sourceId: "core-rules-gfr-2017", pageNumber: 43 } });
  assert.deepEqual(parseRef("12#3#4#2024"), { sourceId: "12#3#4#2024" });
  console.log("research agent tests passed");
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
