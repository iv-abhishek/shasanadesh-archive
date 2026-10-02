/**
 * Keep one development profile and delete the others (with their
 * conversations, messages, departments, sessions and feedback — all ON DELETE
 * CASCADE). Shows the plan and changes nothing unless --confirm is given.
 *
 *   npm run workspace:prune -- --keep "Abhishek Srivastava"            (plan only)
 *   npm run workspace:prune -- --keep "Abhishek Srivastava" --confirm  (delete)
 *
 * --keep takes a display name (the profile with that name and the most
 * conversations is kept) or a profile ID.
 */

import { createPool } from "../db/client.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const keepArg = option("--keep")?.trim();
  if (!keepArg) throw new Error('Say which profile to keep: --keep "Abhishek Srivastava" (or a profile ID).');
  const confirm = process.argv.includes("--confirm");
  const pool = createPool();
  try {
    const { rows } = await pool.query<{
      id: string;
      display_name: string;
      designation: string | null;
      conversations: number;
      messages: number;
      created_at: Date;
    }>(`
      SELECT u.id, u.display_name, u.designation, u.created_at,
        (SELECT COUNT(*)::int FROM conversations c WHERE c.user_id = u.id) AS conversations,
        (SELECT COUNT(*)::int FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = u.id) AS messages
      FROM workspace_users u
      ORDER BY conversations DESC, u.created_at ASC
    `);
    if (!rows.length) {
      console.log("No profiles.");
      return;
    }

    const byId = rows.find((row) => row.id === keepArg);
    const byName = rows.filter((row) => row.display_name.trim().toLowerCase() === keepArg.toLowerCase());
    const keep = byId ?? byName[0]; // most conversations first
    if (!keep) {
      console.log(`No profile named "${keepArg}". Profiles:`);
      for (const row of rows) console.log(`  ${row.display_name} (${row.designation ?? "—"}) · ${row.conversations} conversations · ${row.id}`);
      process.exitCode = 1;
      return;
    }

    const remove = rows.filter((row) => row.id !== keep.id);
    console.log(`KEEP    ${keep.display_name} (${keep.designation ?? "—"}) · ${keep.conversations} conversations, ${keep.messages} messages · ${keep.id}`);
    for (const row of remove) {
      console.log(`DELETE  ${row.display_name} (${row.designation ?? "—"}) · ${row.conversations} conversations, ${row.messages} messages · ${row.id}`);
    }
    if (!remove.length) {
      console.log("Nothing to delete.");
      return;
    }
    if (!confirm) {
      console.log("\nNothing changed. Run again with --confirm to delete the profiles marked DELETE (cannot be undone).");
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("DELETE FROM workspace_users WHERE id = ANY($1::uuid[])", [remove.map((row) => row.id)]);
      await client.query("COMMIT");
      console.log(`\nDeleted ${result.rowCount} profiles and their conversations. Kept ${keep.display_name}.`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Profile clean-up stopped:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
