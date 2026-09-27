/**
 * HTTP routes for browsing the archive (read-only).
 *
 *   POST /api/documents/browse  → every order matching the filters, paged
 *   POST /api/documents/facets  → department / section / category choices with counts
 *   POST /api/documents/classification → a person corrects an order's tier
 *     (internal archive console). Takes effect in the database at once and is
 *     appended to datasets/classification-overrides.jsonl so the next
 *     classify:orders + db:load keeps it. Refused in production unless
 *     ARCHIVE_CONSOLE_WRITE=1 (there is no admin sign-in yet).
 *
 * The web app reaches these through its same-origin proxy (/api/rag/documents/*).
 */

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { createPool } from "../db/client.js";
import { browseDocuments, browseFacets } from "./browse.js";

const text = (max: number) => z.string().max(max).optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

const FiltersSchema = z.object({
  providers: z.array(z.string().max(60)).max(10).optional(),
  departmentKeys: z.array(z.string().max(300)).max(50).optional(),
  scopeDepartments: z.array(z.string().max(300)).max(50).optional(),
  section: text(300),
  category: text(300),
  goNumber: text(120),
  text: text(300),
  dateFrom: isoDate,
  dateTo: isoDate,
  tiers: z.array(z.enum(["A", "B", "C", "none"])).max(4).optional(),
  jurisdictions: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(10).optional(),
  topics: z.array(z.string().regex(/^[a-z-]{2,40}$/)).max(10).optional(),
});

const BrowseSchema = FiltersSchema.extend({
  page: z.number().int().min(1).max(100_000).optional(),
  pageSize: z.number().int().min(10).max(100).optional(),
  sort: z.enum(["date_desc", "date_asc"]).optional(),
});

const FacetsSchema = z.object({
  providers: z.array(z.string().max(60)).max(10).optional(),
  departmentKeys: z.array(z.string().max(300)).max(50).optional(),
});

const ClassificationSchema = z.object({
  sourceId: z.string().min(1).max(200),
  tier: z.enum(["A", "B", "C"]),
  docType: z.string().regex(/^[a-z-]{2,40}$/).optional(),
  note: z.string().max(500).optional(),
});

const OVERRIDES_PATH = path.resolve("datasets/classification-overrides.jsonl");

let pool: Pool | null = null;
const getPool = () => (pool ??= createPool());

export function registerDocumentRoutes(server: FastifyInstance): void {
  server.post("/api/documents/browse", async (request, reply) => {
    const parsed = BrowseSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid browse request", issues: parsed.error.issues });
    }
    return browseDocuments(getPool(), parsed.data);
  });

  server.post("/api/documents/classification", async (request, reply) => {
    if (process.env.NODE_ENV === "production" && process.env.ARCHIVE_CONSOLE_WRITE !== "1") {
      return reply.code(403).send({ error: "Classification changes are disabled on this server." });
    }
    const parsed = ClassificationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid classification", issues: parsed.error.issues });
    }
    const { sourceId, tier, docType, note } = parsed.data;
    const override = {
      sourceId,
      tier,
      ...(docType ? { docType } : {}),
      ...(note ? { note } : {}),
      reviewedBy: "archive console",
      reviewedAt: new Date().toISOString(),
    };
    const result = await getPool().query(
      `
        UPDATE documents
        SET tier = $2,
            doc_type = COALESCE($3, doc_type),
            classification = COALESCE(classification, '{}'::jsonb)
              || jsonb_build_object('confidence', 'high', 'decidedBy', 'override', 'override', $4::jsonb)
        WHERE source_id = $1
        RETURNING tier, doc_type
      `,
      [sourceId, tier, docType ?? null, JSON.stringify(override)],
    );
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: `Unknown order ${sourceId}` });
    }
    // Append-only history; classify:orders applies the last entry per order.
    await appendFile(OVERRIDES_PATH, JSON.stringify(override) + "\n", "utf8");
    return { sourceId, tier: result.rows[0].tier, docType: result.rows[0].doc_type };
  });

  server.post("/api/documents/facets", async (request, reply) => {
    const parsed = FacetsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid facets request", issues: parsed.error.issues });
    }
    return browseFacets(getPool(), parsed.data);
  });
}
