/**
 * Quick database integrity/coverage audit after corpus loading.
 */

import { createPool } from "./client.js";

async function main() {
  const pool = createPool();

  try {
    const [
      documents,
      pages,
      variants,
      canonicalVariants,
      alternateVariants,
      conflictPages,
      chunks,
      embeddings,
    ] = await Promise.all([
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM documents",
      ),
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM pages",
      ),
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM page_variants",
      ),
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM page_variants WHERE canonical = TRUE",
      ),
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM page_variants WHERE canonical = FALSE",
      ),
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM pages WHERE numeric_conflict = TRUE",
      ),
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM chunks",
      ),
      pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM chunks WHERE embedding IS NOT NULL",
      ),
    ]);

    console.log("PostgreSQL corpus audit");
    console.log("=======================");
    console.log(`Documents:           ${documents.rows[0].count}`);
    console.log(`Logical pages:       ${pages.rows[0].count}`);
    console.log(`Page variants:       ${variants.rows[0].count}`);
    console.log(`Canonical variants:  ${canonicalVariants.rows[0].count}`);
    console.log(`Alternate variants:  ${alternateVariants.rows[0].count}`);
    console.log(`Numeric conflicts:   ${conflictPages.rows[0].count}`);
    console.log(`Chunks:              ${chunks.rows[0].count}`);
    console.log(`Embedded chunks:     ${embeddings.rows[0].count}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
