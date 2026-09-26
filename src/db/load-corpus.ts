/**
 * Load the current local corpus into PostgreSQL.
 *
 * Data model:
 *   documents
 *     -> logical pages
 *       -> native/OCR page variants
 *         -> variant chunks
 *
 * Numeric conflict is computed at the logical-page level by comparing the
 * native and OCR numeric-token sets. This is a warning for downstream answer
 * generation; it is not an automatic correctness judgment.
 *
 * The local corpus files are the source of truth for every source they
 * contain. After upserting, rows for those sources that are no longer in the
 * corpus (for example a native canonical variant replaced by OCR, or a page
 * that now produces fewer chunks) are deleted in the same transaction, so
 * stale text cannot keep competing in retrieval. Documents that are absent
 * from the corpus files are left untouched.
 */

import {
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { createPool } from "./client.js";
import { toIsoGoDate } from "../lib/go-date.js";

const documentsRoot = path.resolve("data/documents");
const retrievalPagesPath = path.resolve(
  "data/corpus/retrieval-pages.jsonl",
);
const retrievalChunksPath = path.resolve(
  "data/corpus/retrieval-variant-chunks.jsonl",
);

interface Metadata {
  provider?: string;
  sourceId: string;
  encodedId?: string;
  sourceUrl: string;
  department?: string | null;
  goDate?: string | null;
  goNumber?: string | null;
  verificationStatus?: string;
  idParts?: {
    sequence?: number;
    departmentId?: number;
    sectionId?: number;
    year?: number;
  };
  capture?: {
    downloadedAt?: string;
    status?: number;
    contentType?: string | null;
    bytes?: number;
    rawSha256?: string;
  };
  pdf?: {
    pages?: number | null;
  };
}

interface RetrievalPageVariant {
  variantId: string;
  sourceId: string;
  pageNumber: number;
  variant: "native" | "ocr";
  canonical: boolean;
  text: string;
  chars: number;
  numericTokens: string[];
}

interface VariantChunk {
  variantChunkId: string;
  logicalPageId: string;
  sourceId: string;
  pageNumber: number;
  variant: "native" | "ocr";
  canonical: boolean;
  chunkIndex: number;
  text: string;
  chars: number;
  sha256: string;
}

function sameStringSet(a: string[], b: string[]): boolean {
  const aa = new Set(a);
  const bb = new Set(b);

  if (aa.size !== bb.size) return false;

  for (const value of aa) {
    if (!bb.has(value)) return false;
  }

  return true;
}

// ISO or the portal's day-first DD/MM/YYYY; anything else stays null.
const toDateOrNull = toIsoGoDate;

async function loadDocuments(client: PoolClient): Promise<number> {
  const entries = await readdir(documentsRoot, {
    withFileTypes: true,
  });

  let count = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const metadataPath = path.join(
      documentsRoot,
      entry.name,
      "metadata.json",
    );

    let metadata: Metadata;

    try {
      metadata = JSON.parse(
        await readFile(metadataPath, "utf8"),
      ) as Metadata;
    } catch {
      continue;
    }

    await client.query(
      `
      INSERT INTO documents (
        source_id,
        provider,
        encoded_id,
        source_url,
        department,
        go_number,
        go_date,
        sequence_number,
        department_id,
        section_id,
        source_year,
        verification_status,
        capture_downloaded_at,
        capture_http_status,
        capture_content_type,
        capture_bytes,
        raw_sha256,
        page_count,
        metadata,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        $13,$14,$15,$16,$17,$18,$19::jsonb,NOW()
      )
      ON CONFLICT (source_id)
      DO UPDATE SET
        provider = EXCLUDED.provider,
        encoded_id = EXCLUDED.encoded_id,
        source_url = EXCLUDED.source_url,
        department = EXCLUDED.department,
        go_number = EXCLUDED.go_number,
        go_date = EXCLUDED.go_date,
        sequence_number = EXCLUDED.sequence_number,
        department_id = EXCLUDED.department_id,
        section_id = EXCLUDED.section_id,
        source_year = EXCLUDED.source_year,
        verification_status = EXCLUDED.verification_status,
        capture_downloaded_at = EXCLUDED.capture_downloaded_at,
        capture_http_status = EXCLUDED.capture_http_status,
        capture_content_type = EXCLUDED.capture_content_type,
        capture_bytes = EXCLUDED.capture_bytes,
        raw_sha256 = EXCLUDED.raw_sha256,
        page_count = EXCLUDED.page_count,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      `,
      [
        metadata.sourceId,
        metadata.provider ?? "shasanadesh-up",
        metadata.encodedId ?? null,
        metadata.sourceUrl,
        metadata.department ?? null,
        metadata.goNumber ?? null,
        toDateOrNull(metadata.goDate),
        metadata.idParts?.sequence ?? null,
        metadata.idParts?.departmentId ?? null,
        metadata.idParts?.sectionId ?? null,
        metadata.idParts?.year ?? null,
        metadata.verificationStatus ?? null,
        metadata.capture?.downloadedAt ?? null,
        metadata.capture?.status ?? null,
        metadata.capture?.contentType ?? null,
        metadata.capture?.bytes ?? null,
        metadata.capture?.rawSha256 ?? null,
        metadata.pdf?.pages ?? null,
        JSON.stringify(metadata),
      ],
    );

    count++;
  }

  return count;
}

interface PageLoadStats {
  pages: number;
  variants: number;
  conflicts: number;
  sourceIds: string[];
  pageKeys: string[];
  variantIds: string[];
}

async function loadPagesAndVariants(
  client: PoolClient,
): Promise<PageLoadStats> {
  const variants = (await readFile(retrievalPagesPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RetrievalPageVariant);

  const grouped = new Map<string, RetrievalPageVariant[]>();

  for (const variant of variants) {
    const key = `${variant.sourceId}#${variant.pageNumber}`;
    const rows = grouped.get(key) ?? [];
    rows.push(variant);
    grouped.set(key, rows);
  }

  let conflictCount = 0;

  for (const rows of grouped.values()) {
    const first = rows[0];
    const canonical = rows.find((row) => row.canonical) ?? first;

    const native = rows.find((row) => row.variant === "native");
    const ocr = rows.find(
      (row) =>
        row.variant === "ocr" &&
        !row.canonical,
    );

    const numericConflict =
      Boolean(native && ocr) &&
      !sameStringSet(
        native?.numericTokens ?? [],
        ocr?.numericTokens ?? [],
      );

    if (numericConflict) conflictCount++;

    await client.query(
      `
      INSERT INTO pages (
        source_id,
        page_number,
        canonical_variant,
        numeric_conflict,
        updated_at
      )
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (source_id, page_number)
      DO UPDATE SET
        canonical_variant = EXCLUDED.canonical_variant,
        numeric_conflict = EXCLUDED.numeric_conflict,
        updated_at = NOW()
      `,
      [
        first.sourceId,
        first.pageNumber,
        canonical.variant,
        numericConflict,
      ],
    );

    for (const variant of rows) {
      await client.query(
        `
        INSERT INTO page_variants (
          variant_id,
          source_id,
          page_number,
          variant_type,
          canonical,
          text_content,
          chars,
          numeric_tokens,
          metadata,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())
        ON CONFLICT (variant_id)
        DO UPDATE SET
          variant_type = EXCLUDED.variant_type,
          canonical = EXCLUDED.canonical,
          text_content = EXCLUDED.text_content,
          chars = EXCLUDED.chars,
          numeric_tokens = EXCLUDED.numeric_tokens,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
        `,
        [
          variant.variantId,
          variant.sourceId,
          variant.pageNumber,
          variant.variant,
          variant.canonical,
          variant.text,
          variant.chars,
          variant.numericTokens,
          JSON.stringify({
            source: "data/corpus/retrieval-pages.jsonl",
          }),
        ],
      );
    }
  }

  return {
    pages: grouped.size,
    variants: variants.length,
    conflicts: conflictCount,
    sourceIds: [...new Set(variants.map((row) => row.sourceId))],
    pageKeys: [...grouped.keys()],
    variantIds: variants.map((row) => row.variantId),
  };
}

async function loadChunks(
  client: PoolClient,
): Promise<{ count: number; chunkIds: string[] }> {
  const chunks = (await readFile(retrievalChunksPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as VariantChunk);

  for (const chunk of chunks) {
    const variantId =
      `${chunk.sourceId}:p${chunk.pageNumber}:` +
      `${chunk.variant}:` +
      `${chunk.canonical ? "canonical" : "alternate"}`;

    await client.query(
      `
      INSERT INTO chunks (
        variant_chunk_id,
        logical_page_id,
        source_id,
        page_number,
        variant_id,
        variant_type,
        canonical,
        chunk_index,
        text_content,
        chars,
        text_sha256,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      ON CONFLICT (variant_chunk_id)
      DO UPDATE SET
        logical_page_id = EXCLUDED.logical_page_id,
        variant_id = EXCLUDED.variant_id,
        variant_type = EXCLUDED.variant_type,
        canonical = EXCLUDED.canonical,
        chunk_index = EXCLUDED.chunk_index,
        text_content = EXCLUDED.text_content,
        chars = EXCLUDED.chars,
        text_sha256 = EXCLUDED.text_sha256,
        updated_at = NOW()
      `,
      [
        chunk.variantChunkId,
        chunk.logicalPageId,
        chunk.sourceId,
        chunk.pageNumber,
        variantId,
        chunk.variant,
        chunk.canonical,
        chunk.chunkIndex,
        chunk.text,
        chunk.chars,
        chunk.sha256,
      ],
    );
  }

  return {
    count: chunks.length,
    chunkIds: chunks.map((chunk) => chunk.variantChunkId),
  };
}

/**
 * Delete rows for the loaded sources that the current corpus no longer
 * produces. Chunks go first, then variants, then logical pages.
 */
async function pruneStaleRows(
  client: PoolClient,
  pageStats: PageLoadStats,
  chunkIds: string[],
): Promise<{ chunks: number; variants: number; pages: number }> {
  if (pageStats.sourceIds.length === 0) {
    return { chunks: 0, variants: 0, pages: 0 };
  }

  const chunks = await client.query(
    `
    DELETE FROM chunks
    WHERE source_id = ANY($1::text[])
      AND NOT (variant_chunk_id = ANY($2::text[]))
    `,
    [pageStats.sourceIds, chunkIds],
  );

  const variants = await client.query(
    `
    DELETE FROM page_variants
    WHERE source_id = ANY($1::text[])
      AND NOT (variant_id = ANY($2::text[]))
    `,
    [pageStats.sourceIds, pageStats.variantIds],
  );

  const pages = await client.query(
    `
    DELETE FROM pages
    WHERE source_id = ANY($1::text[])
      AND NOT ((source_id || '#' || page_number::text) = ANY($2::text[]))
    `,
    [pageStats.sourceIds, pageStats.pageKeys],
  );

  return {
    chunks: chunks.rowCount ?? 0,
    variants: variants.rowCount ?? 0,
    pages: pages.rowCount ?? 0,
  };
}

/**
 * Copy data/corpus/classification.jsonl (npm run classify:orders) into
 * documents.doc_type / tier / classification. Orders not in the file keep
 * NULL (treated as "not classified": Ask still uses them).
 */
async function loadClassification(client: PoolClient): Promise<number> {
  const file = path.resolve("data/corpus/classification.jsonl");
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch {
    return 0;
  }

  const ids: string[] = [];
  const types: string[] = [];
  const tiers: string[] = [];
  const details: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as {
      sourceId: string;
      docType: string;
      tier: string;
      confidence: string;
      reasons: string[];
      rulesVersion: string;
      override?: unknown;
    };
    ids.push(record.sourceId);
    types.push(record.docType);
    tiers.push(record.tier);
    details.push(JSON.stringify({
      confidence: record.confidence,
      reasons: record.reasons,
      rulesVersion: record.rulesVersion,
      ...(record.override ? { override: record.override } : {}),
    }));
  }

  if (!ids.length) return 0;
  const result = await client.query(
    `
    UPDATE documents d
    SET doc_type = c.doc_type, tier = c.tier, classification = c.details::jsonb
    FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
      AS c(source_id, doc_type, tier, details)
    WHERE d.source_id = c.source_id
    `,
    [ids, types, tiers, details],
  );
  return result.rowCount ?? 0;
}

async function main() {
  const pool = createPool();
  const client = await pool.connect();

  const run = await client.query<{ id: string }>(
    `
    INSERT INTO ingestion_runs (stage)
    VALUES ('load-local-retrieval-corpus')
    RETURNING id
    `,
  );

  const runId = run.rows[0].id;

  try {
    await client.query("BEGIN");

    const documents = await loadDocuments(client);
    const classified = await loadClassification(client);
    const pageStats = await loadPagesAndVariants(client);
    const chunkStats = await loadChunks(client);
    const chunks = chunkStats.count;
    const pruned = await pruneStaleRows(
      client,
      pageStats,
      chunkStats.chunkIds,
    );

    await client.query(
      `
      UPDATE ingestion_runs
      SET
        completed_at = NOW(),
        status = 'completed',
        documents_processed = $2,
        pages_processed = $3,
        variants_processed = $4,
        chunks_processed = $5,
        details = $6::jsonb
      WHERE id = $1
      `,
      [
        runId,
        documents,
        pageStats.pages,
        pageStats.variants,
        chunks,
        JSON.stringify({
          numericConflictPages: pageStats.conflicts,
          pruned,
        }),
      ],
    );

    await client.query("COMMIT");

    console.log("Corpus loaded into PostgreSQL");
    console.log("=============================");
    console.log(`Documents:          ${documents}`);
    console.log(`Classified:         ${classified}${classified ? "" : " (run npm run classify:orders first)"}`);
    console.log(`Logical pages:      ${pageStats.pages}`);
    console.log(`Page variants:      ${pageStats.variants}`);
    console.log(`Numeric conflicts:  ${pageStats.conflicts}`);
    console.log(`Variant chunks:     ${chunks}`);
    console.log(
      `Stale rows removed: ${pruned.chunks} chunks, ` +
        `${pruned.variants} variants, ${pruned.pages} pages`,
    );
    console.log(`Ingestion run ID:   ${runId}`);
  } catch (error) {
    await client.query("ROLLBACK");

    await pool.query(
      `
      UPDATE ingestion_runs
      SET completed_at = NOW(), status = 'failed', details = $2::jsonb
      WHERE id = $1
      `,
      [
        runId,
        JSON.stringify({
          error:
            error instanceof Error
              ? error.message
              : String(error),
        }),
      ],
    );

    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
