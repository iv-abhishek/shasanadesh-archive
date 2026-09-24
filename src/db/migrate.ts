/**
 * Ordered migration runner with checksum tracking.
 *
 * Earlier development re-ran an idempotent 001 migration on every invocation.
 * From this point forward, migrations are recorded in schema_migrations so
 * later schema changes can safely be non-idempotent when needed.
 */

import {
  createHash,
} from "node:crypto";
import {
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";

import {
  createPool,
} from "./client.js";

interface MigrationRow {
  name: string;
  checksum: string;
}

async function main():
  Promise<void> {
  const migrationsDir =
    path.resolve(
      "db/migrations",
    );

  const names =
    (
      await readdir(
        migrationsDir,
      )
    )
      .filter(
        (name) =>
          /^\d+.*\.sql$/.test(
            name,
          ),
      )
      .sort();

  if (
    names.length === 0
  ) {
    throw new Error(
      "No SQL migrations found.",
    );
  }

  const pool =
    createPool();

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (
      const name of names
    ) {
      const filePath =
        path.join(
          migrationsDir,
          name,
        );

      const sql =
        await readFile(
          filePath,
          "utf8",
        );

      const checksum =
        createHash(
          "sha256",
        )
          .update(sql)
          .digest("hex");

      const existing =
        await pool.query<MigrationRow>(
          `
            SELECT
              name,
              checksum
            FROM schema_migrations
            WHERE name = $1
          `,
          [name],
        );

      if (
        existing.rowCount &&
        existing.rows[0]
      ) {
        if (
          existing.rows[0]
            .checksum !==
          checksum
        ) {
          throw new Error(
            `Migration ${name} was already applied with a different checksum.`,
          );
        }

        console.log(
          `Already applied: ${name}`,
        );

        continue;
      }

      const client =
        await pool.connect();

      try {
        await client.query(
          "BEGIN",
        );

        await client.query(
          sql,
        );

        await client.query(
          `
            INSERT INTO schema_migrations (
              name,
              checksum
            )
            VALUES ($1, $2)
          `,
          [
            name,
            checksum,
          ],
        );

        await client.query(
          "COMMIT",
        );

        console.log(
          `Applied: ${name}`,
        );
      } catch (error) {
        await client.query(
          "ROLLBACK",
        );

        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch(
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
