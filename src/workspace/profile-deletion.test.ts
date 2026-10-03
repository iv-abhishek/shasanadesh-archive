/**
 * Profile delete, restore and purge (ADR-079) against a real PostgreSQL.
 *
 * Run it with `npm run test:profile-deletion`: that creates a throwaway
 * database, migrates it, runs this file and drops it again
 * (scripts/test-profile-deletion.sh). Run directly, it needs TEST_DATABASE_URL
 * pointing to an EMPTY migrated scratch database and is skipped otherwise.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (!process.env.TEST_DATABASE_URL) {
  console.log("profile deletion tests skipped (set TEST_DATABASE_URL to an empty, migrated scratch database)");
  process.exit(0);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

async function main(): Promise<void> {

  const { default: Fastify } = await import("fastify");
  const { Pool } = await import("pg");
  const { registerSessionRoutes } = await import("./session-routes.js");
  const store = await import("./store.js");
  const { MAX_WORKSPACE_PROFILES } = await import("./model.js");

  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const existing = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM workspace_users");
  assert.equal(existing.rows[0].n, 0, "TEST_DATABASE_URL must point to an empty scratch database");

  async function addProfile(name: string): Promise<string> {
    const id = randomUUID();
    await db.query("INSERT INTO workspace_users (id, display_name) VALUES ($1, $2)", [id, name]);
    return id;
  }

  const server = Fastify();
  registerSessionRoutes(server);
  await server.ready();

  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"] ?? "").split(";")[0];

  try {
    const ids: string[] = [];
    for (let i = 1; i <= MAX_WORKSPACE_PROFILES; i++) ids.push(await addProfile(`Officer ${i}`));
    const [first, second] = ids;

    // A conversation, a message and feedback that must go with the profile.
    const conversation = randomUUID();
    const message = randomUUID();
    await db.query("INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, 'Leave rules')", [conversation, first]);
    await db.query("INSERT INTO conversation_messages (id, conversation_id, role, content) VALUES ($1, $2, 'assistant', 'answer')", [message, conversation]);
    await db.query("INSERT INTO message_feedback (message_id, user_id, rating) VALUES ($1, $2, 'up')", [message, first]);

    // Sign in as the first profile.
    const login = await server.inject({ method: "POST", url: "/api/session/dev-login", payload: { userId: first } });
    assert.equal(login.statusCode, 200);
    const cookie = cookieOf(login);

    const summary = await server.inject({ method: "GET", url: `/api/session/dev-users/${first}/summary` });
    assert.deepEqual(summary.json(), { conversationCount: 1, restoreDays: 30 });

    // Delete the signed-in profile: signed out, gone from the list, slot freed.
    const deleted = await server.inject({ method: "DELETE", url: `/api/session/dev-users/${first}`, headers: { cookie } });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.json().signedOut, true);
    const days = (Date.parse(deleted.json().purgeAfter) - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30, `purge in 30 days, got ${days}`);
    assert.match(String(deleted.headers["set-cookie"]), /Max-Age=0|Expires=Thu, 01 Jan 1970/i);

    const me = await server.inject({ method: "GET", url: "/api/session/me", headers: { cookie } });
    assert.equal(me.statusCode, 401, "the old session no longer works");
    const relogin = await server.inject({ method: "POST", url: "/api/session/dev-login", payload: { userId: first } });
    assert.equal(relogin.statusCode, 404, "a deleted profile cannot sign in");

    const list = (await server.inject({ method: "GET", url: "/api/session/dev-users" })).json();
    assert.equal(list.profiles.length, MAX_WORKSPACE_PROFILES - 1);
    assert.ok(!list.profiles.some((profile: { id: string }) => profile.id === first));

    const recentlyDeleted = (await server.inject({ method: "GET", url: "/api/session/dev-users/deleted" })).json();
    assert.equal(recentlyDeleted.profiles.length, 1);
    assert.equal(recentlyDeleted.profiles[0].displayName, "Officer 1");
    assert.equal(recentlyDeleted.profiles[0].conversationCount, 1);

    // Deleting twice keeps the first purge date.
    const again = await server.inject({ method: "DELETE", url: `/api/session/dev-users/${first}` });
    assert.equal(again.json().purgeAfter, deleted.json().purgeAfter);

    // The freed slot can be used; then restoring needs a free slot.
    const sixth = await addProfile("Officer 6");
    const full = await server.inject({ method: "POST", url: `/api/session/dev-users/${first}/restore` });
    assert.equal(full.statusCode, 409);
    await db.query("DELETE FROM workspace_users WHERE id = $1", [sixth]);
    const restored = await server.inject({ method: "POST", url: `/api/session/dev-users/${first}/restore` });
    assert.equal(restored.statusCode, 200);
    const back = await db.query("SELECT deleted_at, purge_after FROM workspace_users WHERE id = $1", [first]);
    assert.equal(back.rows[0].deleted_at, null);
    assert.equal(back.rows[0].purge_after, null);
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM conversations WHERE user_id = $1", [first])).rows[0].n, 1, "restore keeps conversations");

    // Delete now: only a deleted profile can be purged; everything goes with it.
    const notDeleted = await server.inject({ method: "DELETE", url: `/api/session/dev-users/${first}/permanent` });
    assert.equal(notDeleted.statusCode, 404);
    await server.inject({ method: "DELETE", url: `/api/session/dev-users/${first}` });
    const now = await server.inject({ method: "DELETE", url: `/api/session/dev-users/${first}/permanent` });
    assert.equal(now.statusCode, 200);
    for (const [table, column, value] of [
      ["workspace_users", "id", first],
      ["conversations", "user_id", first],
      ["conversation_messages", "id", message],
      ["message_feedback", "message_id", message],
      ["workspace_sessions", "user_id", first],
    ] as const) {
      const left = await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column} = $1`, [value]);
      assert.equal(left.rows[0].n, 0, `${table} purged`);
    }

    // The daily purge removes only profiles past their window.
    await store.softDeleteWorkspaceProfile(second);
    assert.equal(await store.purgeDeletedProfiles(), 0, "not due yet");
    await db.query("UPDATE workspace_users SET purge_after = NOW() - INTERVAL '1 minute' WHERE id = $1", [second]);
    assert.equal(await store.purgeDeletedProfiles(), 1);
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM workspace_users")).rows[0].n, MAX_WORKSPACE_PROFILES - 2);

    // The last active profile cannot be deleted.
    const remaining = (await db.query<{ id: string }>("SELECT id FROM workspace_users WHERE deleted_at IS NULL ORDER BY created_at")).rows.map((row) => row.id);
    for (const id of remaining.slice(1)) await store.softDeleteWorkspaceProfile(id);
    const last = await server.inject({ method: "DELETE", url: `/api/session/dev-users/${remaining[0]}` });
    assert.equal(last.statusCode, 409);
    assert.match(last.json().message, /only profile/);
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM workspace_users WHERE deleted_at IS NULL")).rows[0].n, 1);

    // Bad IDs are rejected before touching the database.
    assert.equal((await server.inject({ method: "DELETE", url: "/api/session/dev-users/not-a-uuid" })).statusCode, 400);
    assert.equal((await server.inject({ method: "DELETE", url: `/api/session/dev-users/${randomUUID()}` })).statusCode, 404);

    console.log("profile deletion tests passed");
  } finally {
    await server.close();
    await db.query("DELETE FROM workspace_users");
    await db.end();
    await store.closeWorkspacePool();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
