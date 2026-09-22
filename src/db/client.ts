/**
 * Shared PostgreSQL connection helper.
 *
 * DATABASE_URL is intentionally the only required connection parameter at this
 * layer. Never hard-code production credentials in source code.
 */

import { Pool } from "pg";

export function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Example local URL: " +
        "postgresql://shasanadesh:shasanadesh_dev@localhost:5432/shasanadesh",
    );
  }

  return new Pool({
    connectionString,
    max: 10,
  });
}
