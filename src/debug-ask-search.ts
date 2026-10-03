/**
 * npm run debug:search -- "question"
 *
 * Shows what Ask's search finds for a question, without writing an answer:
 * the corrected question and search wordings (ADR-082/086), then each page
 * with its relevance, authority and opening text. For diagnosing "why did it
 * not find GFR?". Needs the retrieval service running (npm run dev:all).
 */
import { expandSearchQuery } from "./rag/query-expansion.js";

const RETRIEVAL_BASE_URL = process.env.RETRIEVAL_BASE_URL ?? "http://127.0.0.1:8788";

async function main(): Promise<void> {
  const question = process.argv.slice(2).filter((arg) => arg !== "--").join(" ").trim();
  if (!question) throw new Error('Usage: npm run debug:search -- "your question"');
  const plan = await expandSearchQuery(question);
  console.log(`Question:   ${question}`);
  console.log(`Corrected:  ${plan.corrected ?? "(unchanged)"}`);
  plan.expansions.forEach((text, index) => console.log(`Wording ${index + 1}:  ${text}`));
  const started = Date.now();
  const response = await fetch(`${RETRIEVAL_BASE_URL}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: plan.corrected ?? question,
      top_k: 10,
      candidate_count: 50,
      rerank_count: 36,
      prefer_authority: true,
      expansions: plan.expansions,
      filters: { include_routine: true },
    }),
  });
  if (!response.ok) throw new Error(`Retrieval service: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as {
    evidence: Array<{
      source_id: string;
      page_number: number;
      document_title?: string | null;
      tier?: string | null;
      provider?: string | null;
      rerank_score_raw: number;
      retrieval_role?: string;
      selected_page_text: string;
    }>;
    timings?: Record<string, number>;
  };
  console.log(`\nSearch: ${Date.now() - started} ms ${JSON.stringify(data.timings ?? {})}\n`);
  data.evidence.forEach((item, index) => {
    const score = item.rerank_score_raw;
    const relevance = score >= 0 && score <= 1 ? score : 1 / (1 + Math.exp(-score));
    console.log(
      `${String(index + 1).padStart(2)}. ${relevance.toFixed(3)}  ${item.tier ?? "-"}  ${item.retrieval_role ?? "direct"}  ${item.source_id} p.${item.page_number}  ${(item.document_title ?? "").slice(0, 70)}`,
    );
    console.log(`      ${item.selected_page_text.replace(/\s+/g, " ").slice(0, 220)}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
