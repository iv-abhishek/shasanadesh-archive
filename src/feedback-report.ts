/**
 * Review answer feedback:  npm run feedback:report [-- --down] [-- --limit 50]
 *
 * Lists recent votes with the question, the reason and the start of the
 * answer, so thumbs-down answers can be investigated and, once the correct
 * source page is verified, added to eval/rag-cases.json.
 */

import { createPool } from "./db/client.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const onlyDown = process.argv.includes("--down");
  const limit = Math.min(500, Math.max(1, Number.parseInt(option("--limit") ?? "30", 10) || 30));
  const pool = createPool();

  try {
    const totals = await pool.query<{ rating: string; count: string }>(
      "SELECT rating, COUNT(*)::text AS count FROM message_feedback GROUP BY rating ORDER BY rating",
    );

    const rows = await pool.query<{
      rating: string;
      reason: string | null;
      comment: string | null;
      updated_at: Date;
      question: string | null;
      answer: string;
      conversation_id: string;
    }>(
      `
        SELECT
          f.rating,
          f.reason,
          f.comment,
          f.updated_at,
          a.content AS answer,
          a.conversation_id,
          (
            SELECT q.content
            FROM conversation_messages q
            WHERE q.conversation_id = a.conversation_id
              AND q.role = 'user'
              AND (q.created_at, q.id) < (a.created_at, a.id)
            ORDER BY q.created_at DESC, q.id DESC
            LIMIT 1
          ) AS question
        FROM message_feedback f
        JOIN conversation_messages a ON a.id = f.message_id
        WHERE ($1::boolean IS FALSE OR f.rating = 'down')
        ORDER BY f.updated_at DESC
        LIMIT $2
      `,
      [onlyDown, limit],
    );

    console.log("Answer feedback");
    console.log("===============");
    console.log(
      totals.rows.map((row) => `${row.rating === "up" ? "👍" : "👎"} ${row.count}`).join("   ") || "No feedback yet.",
    );

    for (const row of rows.rows) {
      const clip = (text: string | null, max: number) =>
        (text ?? "").replace(/\s+/g, " ").slice(0, max);
      console.log(
        `\n${row.rating === "up" ? "👍" : "👎"} ${row.updated_at.toISOString().slice(0, 16).replace("T", " ")}` +
          (row.reason ? `  reason: ${row.reason}` : ""),
      );
      console.log(`   Q: ${clip(row.question, 160)}`);
      console.log(`   A: ${clip(row.answer, 220)}…`);
      if (row.comment) console.log(`   Comment: ${clip(row.comment, 300)}`);
      console.log(`   Conversation: ${row.conversation_id}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
