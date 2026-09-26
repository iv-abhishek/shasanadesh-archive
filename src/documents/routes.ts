/**
 * HTTP routes for browsing the archive (read-only).
 *
 *   POST /api/documents/browse  → every order matching the filters, paged
 *   POST /api/documents/facets  → department / section / category choices with counts
 *
 * The web app reaches these through its same-origin proxy (/api/rag/documents/*).
 */

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
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

  server.post("/api/documents/facets", async (request, reply) => {
    const parsed = FacetsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid facets request", issues: parsed.error.issues });
    }
    return browseFacets(getPool(), parsed.data);
  });
}
