/**
 * Try the official-website search (ADR-096) on its own:
 *   npm run debug:web -- "maternity leave for female government servants"
 * Uses 2–4 Tavily credits.
 */
import { searchOfficialWeb, WEB_SEARCH_ENABLED } from "./rag/web-search.js";

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) throw new Error('Usage: npm run debug:web -- "question"');
  if (!WEB_SEARCH_ENABLED) throw new Error("Set TAVILY_API_KEY in .env (and do not set RAG_WEB_SEARCH=0).");
  const started = performance.now();
  const results = await searchOfficialWeb(question);
  console.log(`Question: ${question}\nTime: ${Math.round(performance.now() - started)} ms\n`);
  if (!results.length) console.log("No usable official page (the answer would come from general knowledge).");
  results.forEach((r, i) =>
    console.log(`${i + 1}. ${r.score.toFixed(2)} ${r.up ? "UP" : "IN"}  ${r.title}\n   ${r.url}\n   ${r.text.slice(0, 160)}…\n`),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
