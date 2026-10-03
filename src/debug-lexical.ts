/**
 * Check the keyword half of search (ADR-092) against the real database:
 *   npm run debug:lexical -- "bidders past experience criteria as per GFR"
 * Prints the words searched, whether Hindi words survive the 'simple' parser,
 * the query plan (it should use chunk_terms_idx, not a full scan), the time,
 * and the best chunks.
 */
import { execFileSync } from "node:child_process";
import pg from "pg";

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(" ").trim() || "निविदादाता का पूर्व अनुभव मानदंड GeM GTC EMD";
  const terms = JSON.parse(
    execFileSync("python3", ["-c", "import json,sys; from services.lexical import search_terms; print(json.dumps(search_terms(sys.argv[1]), ensure_ascii=False))", question], {
      encoding: "utf8",
    }),
  ) as string[];
  console.log("Question:", question);
  console.log("Words:   ", terms.join(" | ") || "(none: keyword search skipped)");
  if (!terms.length) return;

  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const parsed = await db.query<{ word: string; parsed: string }>(
      "SELECT word, to_tsvector('simple', word)::text AS parsed FROM unnest($1::text[]) AS word",
      [terms],
    );
    for (const row of parsed.rows) {
      const ok = row.parsed.includes(`'${row.word}'`);
      console.log(`  ${ok ? "ok  " : "SPLIT"} ${row.word} -> ${row.parsed}`);
    }

    const ready = (await db.query<{ ready: boolean }>("SELECT to_regclass('public.chunk_terms') IS NOT NULL AS ready")).rows[0].ready;
    const words = ready ? "t.terms" : "to_tsvector('simple', c.text_content)";
    const from = ready ? "chunk_terms t JOIN chunks c ON c.variant_chunk_id = t.variant_chunk_id" : "chunks c";
    const tsquery = `(${terms.map((_, i) => `plainto_tsquery('simple', $${i + 1})`).join(" || ")})`;
    const sql = `SELECT c.source_id, c.page_number, ts_rank_cd(${words}, ${tsquery}, 1) AS score
      FROM ${from} WHERE ${words} @@ ${tsquery} ORDER BY score DESC LIMIT 10`;
    console.log(`\nStored words (migration 015): ${ready ? "yes" : "NO - run npm run db:migrate"}`);

    const plan = await db.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, terms);
    const lines = plan.rows.map((row) => row["QUERY PLAN"]);
    console.log(`Uses index: ${lines.some((line) => /Bitmap Index Scan on (chunk_terms_idx|chunks_fts_idx)/.test(line)) ? "yes" : "NO"}`);
    console.log(lines.filter((line) => /Index|Seq Scan|rows=|Execution Time/.test(line)).slice(0, 8).join("\n"));

    const started = performance.now();
    const hits = await db.query<{ source_id: string; page_number: number; score: number }>(sql, terms);
    console.log(`\nKeyword search: ${Math.round(performance.now() - started)} ms`);
    hits.rows.forEach((row, i) => console.log(`${String(i + 1).padStart(2)}. ${Number(row.score).toFixed(3)}  ${row.source_id} p.${row.page_number}`));
  } finally {
    await db.end();
}
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
