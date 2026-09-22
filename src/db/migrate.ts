/**
 * Apply all SQL migrations in db/migrations in filename order.
 *
 * Migrations are written to be idempotent during the current prototype stage.
 * Later, when schema evolution becomes more complex, replace this lightweight
 * runner with a migration table/framework that records each applied version.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createPool } from "./client.js";

async function main() {
  const migrationsDir = path.resolve("db/migrations");

  const migrations = (await readdir(migrationsDir))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b));

  if (migrations.length === 0) {
    throw new Error(`No SQL migrations found in ${migrationsDir}`);
  }

  const pool = createPool();

  try {
    for (const name of migrations) {
      const migrationPath = path.join(migrationsDir, name);
      const sql = await readFile(migrationPath, "utf8");

      await pool.query(sql);
      console.log(`Applied migration: ${migrationPath}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
