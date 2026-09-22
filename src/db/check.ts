/**
 * Diagnose the PostgreSQL connection before running migrations.
 *
 * This prevents confusing migration/load errors when DATABASE_URL points to
 * another PostgreSQL instance already listening on localhost:5432.
 */

import { createPool } from "./client.js";

async function main() {
  const pool = createPool();

  try {
    const result = await pool.query<{
      current_database: string;
      current_user: string;
      version: string;
      server_addr: string | null;
      server_port: number | null;
      vector_available: boolean;
      vector_installed: boolean;
    }>(`
      SELECT
        current_database(),
        current_user,
        version(),
        inet_server_addr()::text AS server_addr,
        inet_server_port() AS server_port,
        EXISTS (
          SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
        ) AS vector_available,
        EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'vector'
        ) AS vector_installed
    `);

    const row = result.rows[0];

    console.log("PostgreSQL connection check");
    console.log("===========================");
    console.log(`Database:          ${row.current_database}`);
    console.log(`User:              ${row.current_user}`);
    console.log(`Server:            ${row.server_addr ?? "local socket"}:${row.server_port ?? ""}`);
    console.log(`pgvector available:${row.vector_available ? " yes" : " no"}`);
    console.log(`pgvector installed:${row.vector_installed ? " yes" : " no"}`);
    console.log(`Version:           ${row.version}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("PostgreSQL connection check failed.");
  console.error(error);
  process.exit(1);
});
