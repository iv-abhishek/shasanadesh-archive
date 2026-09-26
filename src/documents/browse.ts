/**
 * Pipeline stage: archive browsing (read-only)
 *
 * Purpose:
 *   List every archived order that matches a set of filters, the way the
 *   Shasanadesh portal's own search does: department, section, category, GO
 *   number, subject words and date range, newest first, with a total count and
 *   pages of results. Semantic search answers "which pages talk about X";
 *   browsing answers "show me everything issued by X between these dates".
 *
 * Invariants:
 *   - reads only the documents/pages tables; never changes data
 *   - every filter value is a bound parameter (no string-built SQL values)
 *   - department matching follows ADR-044: Shasanadesh department IDs join the
 *     English and Hindi spellings; zero-width joiners are ignored
 *   - an order is listed as soon as its metadata is loaded (db:load), even
 *     before its text is indexed; `indexed` tells the two apart
 */

import type { Pool } from "pg";

/** Zero-width non-joiner and joiner, stripped before comparing names. */
const JOINERS = "‌‍";

const clean = (value: string) => value.replace(/[‌‍]/g, "").replace(/\s+/g, " ").trim();

export interface BrowseFilters {
  providers?: string[];
  /** Keys from browseFacets(): "id:37" (Shasanadesh dept ID) or "name:<department>". */
  departmentKeys?: string[];
  /** The officer's department names ("My departments"), widened by department ID. */
  scopeDepartments?: string[];
  section?: string;
  category?: string;
  goNumber?: string;
  /** Words that must all appear in the subject/title or GO number. */
  text?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Classification tiers to show ("A", "B", "C", or "none" for unclassified). */
  tiers?: string[];
}

export interface BrowseRequest extends BrowseFilters {
  page?: number;
  pageSize?: number;
  sort?: "date_desc" | "date_asc";
}

export interface BrowseRow {
  sourceId: string;
  provider: string;
  department: string | null;
  section: string | null;
  category: string | null;
  goNumber: string | null;
  goDate: string | null;
  /** The date exactly as the listing gave it, when it could not be parsed. */
  goDateText: string | null;
  subject: string | null;
  pageCount: number | null;
  sourceUrl: string;
  /** True once the order's pages are loaded, i.e. it is searchable by text. */
  indexed: boolean;
  inB2: boolean;
  /** Classifier result (npm run classify:orders); null until classified. */
  tier: "A" | "B" | "C" | null;
  docType: string | null;
  classificationConfidence: "high" | "low" | null;
}

export interface BrowseResult {
  total: number;
  page: number;
  pageSize: number;
  rows: BrowseRow[];
}

// SQL expressions over documents d. Portal captures keep section, category and
// subject under metadata.portal; adapter captures keep a title.
const SUBJECT_SQL =
  "COALESCE(NULLIF(d.metadata->>'title', ''), NULLIF(d.metadata->'portal'->>'subject', ''))";
const SECTION_SQL = "NULLIF(d.metadata->'portal'->>'section', '')";
const CATEGORY_SQL = "NULLIF(d.metadata->'portal'->>'category', '')";

/** Build the WHERE clause. Exported for tests. */
export function buildBrowseWhere(filters: BrowseFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const providers = (filters.providers ?? []).map((item) => item.trim()).filter(Boolean);
  if (providers.length) clauses.push(`d.provider = ANY(${param(providers)})`);

  const keys = filters.departmentKeys ?? [];
  const ids = keys
    .filter((key) => key.startsWith("id:"))
    .map((key) => Number(key.slice(3)))
    .filter((id) => Number.isInteger(id));
  const names = keys
    .filter((key) => key.startsWith("name:"))
    .map((key) => clean(key.slice(5)))
    .filter(Boolean);
  const noDepartment = keys.includes("none");
  if (ids.length || names.length || noDepartment) {
    const parts: string[] = [];
    if (ids.length) parts.push(`d.department_id = ANY(${param(ids)})`);
    if (names.length) parts.push(`translate(d.department, ${param(JOINERS)}, '') = ANY(${param(names)})`);
    if (noDepartment) parts.push("NULLIF(TRIM(d.department), '') IS NULL");
    clauses.push(`(${parts.join(" OR ")})`);
  }

  const scope = (filters.scopeDepartments ?? []).map(clean).filter(Boolean);
  if (scope.length) {
    const joiners = param(JOINERS);
    const list = param(scope);
    clauses.push(
      `(translate(d.department, ${joiners}, '') = ANY(${list}) ` +
        "OR d.department_id IN (SELECT DISTINCT dd.department_id FROM documents dd " +
        `WHERE dd.department_id IS NOT NULL AND translate(dd.department, ${joiners}, '') = ANY(${list})) ` +
        "OR d.metadata->>'jurisdiction' = 'central')",
    );
  }

  if (filters.section?.trim()) {
    clauses.push(`translate(${SECTION_SQL}, ${param(JOINERS)}, '') = ${param(clean(filters.section))}`);
  }
  if (filters.category?.trim()) {
    clauses.push(`translate(${CATEGORY_SQL}, ${param(JOINERS)}, '') = ${param(clean(filters.category))}`);
  }
  if (filters.goNumber?.trim()) {
    clauses.push(`d.go_number ILIKE ${param(`%${filters.goNumber.trim()}%`)}`);
  }

  // Every word must appear somewhere in the subject/title or GO number.
  const words = clean(filters.text ?? "").split(" ").filter(Boolean).slice(0, 8);
  if (words.length) {
    const joiners = param(JOINERS);
    for (const word of words) {
      const escaped = word.replace(/[\\%_]/g, (character) => `\\${character}`);
      clauses.push(
        `translate(COALESCE(${SUBJECT_SQL}, '') || ' ' || COALESCE(d.go_number, ''), ${joiners}, '') ILIKE ${param(`%${escaped}%`)}`,
      );
    }
  }

  const tiers = (filters.tiers ?? []).filter((tier) => ["A", "B", "C", "none"].includes(tier));
  if (tiers.length) {
    const parts: string[] = [];
    const named = tiers.filter((tier) => tier !== "none");
    if (named.length) parts.push(`d.tier = ANY(${param(named)})`);
    if (tiers.includes("none")) parts.push("d.tier IS NULL");
    clauses.push(`(${parts.join(" OR ")})`);
  }

  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (filters.dateFrom && isoDate.test(filters.dateFrom)) clauses.push(`d.go_date >= ${param(filters.dateFrom)}::date`);
  if (filters.dateTo && isoDate.test(filters.dateTo)) clauses.push(`d.go_date <= ${param(filters.dateTo)}::date`);

  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export async function browseDocuments(pool: Pool, request: BrowseRequest): Promise<BrowseResult> {
  const pageSize = Math.min(100, Math.max(10, Math.trunc(request.pageSize ?? 50)));
  const page = Math.max(1, Math.trunc(request.page ?? 1));
  const { sql: where, params } = buildBrowseWhere(request);
  const order = request.sort === "date_asc" ? "ASC" : "DESC";

  const total = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM documents d ${where}`, params);

  const rows = await pool.query(
    `
      SELECT
        d.source_id,
        d.provider,
        d.department,
        ${SECTION_SQL} AS section,
        ${CATEGORY_SQL} AS category,
        d.go_number,
        to_char(d.go_date, 'YYYY-MM-DD') AS go_date,
        NULLIF(d.metadata->>'goDate', '') AS go_date_text,
        ${SUBJECT_SQL} AS subject,
        d.page_count,
        d.source_url,
        EXISTS (SELECT 1 FROM pages p WHERE p.source_id = d.source_id) AS indexed,
        (d.metadata->'storage'->'raw'->>'fileId') IS NOT NULL AS in_b2,
        d.tier,
        d.doc_type,
        d.classification->>'confidence' AS classification_confidence
      FROM documents d
      ${where}
      ORDER BY d.go_date ${order} NULLS LAST, d.source_id
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `,
    params,
  );

  return {
    total: Number(total.rows[0]?.count ?? 0),
    page,
    pageSize,
    rows: rows.rows.map((row) => ({
      sourceId: row.source_id,
      provider: row.provider,
      department: row.department,
      section: row.section,
      category: row.category,
      goNumber: row.go_number,
      goDate: row.go_date,
      goDateText: row.go_date ? null : row.go_date_text,
      subject: row.subject,
      pageCount: row.page_count,
      sourceUrl: row.source_url,
      indexed: row.indexed,
      inB2: row.in_b2,
      tier: row.tier ?? null,
      docType: row.doc_type ?? null,
      classificationConfidence: row.classification_confidence ?? null,
    })),
  };
}

export interface DepartmentFacet {
  key: string;
  /** Every spelling seen, e.g. ["Agriculture", "कृषि विभाग"]. */
  names: string[];
  count: number;
}

export interface BrowseFacets {
  total: number;
  departments: DepartmentFacet[];
  /** Sections and categories, limited to the chosen departments when given. */
  sections: Array<{ name: string; count: number }>;
  categories: Array<{ name: string; count: number }>;
  /** Orders per tier ("none" = not classified yet), within the chosen departments. */
  tiers: Array<{ tier: string; count: number }>;
}

/** Drop-down choices with counts, like the portal's department/section lists. */
export async function browseFacets(
  pool: Pool,
  filters: Pick<BrowseFilters, "providers" | "departmentKeys">,
): Promise<BrowseFacets> {
  const providerWhere = buildBrowseWhere({ providers: filters.providers });
  const scoped = buildBrowseWhere({ providers: filters.providers, departmentKeys: filters.departmentKeys });
  const joinerParam = `$${providerWhere.params.length + 1}`;

  const departments = await pool.query<{ key: string; names: string[]; count: string }>(
    `
      SELECT
        CASE
          WHEN d.department_id IS NOT NULL AND d.source_id ~ '^[0-9]+#[0-9]+#[0-9]+#[0-9]{4}$'
            THEN 'id:' || d.department_id
          WHEN NULLIF(TRIM(d.department), '') IS NULL THEN 'none'
          ELSE 'name:' || translate(TRIM(d.department), ${joinerParam}, '')
        END AS key,
        array_agg(DISTINCT translate(TRIM(d.department), ${joinerParam}, ''))
          FILTER (WHERE NULLIF(TRIM(d.department), '') IS NOT NULL) AS names,
        COUNT(*)::text AS count
      FROM documents d
      ${providerWhere.sql}
      GROUP BY 1
      ORDER BY COUNT(*) DESC, 1
    `,
    [...providerWhere.params, JOINERS],
  );

  const listOf = async (expression: string) => {
    const joiner = `$${scoped.params.length + 1}`;
    const result = await pool.query<{ name: string; count: string }>(
      `
        SELECT translate(${expression}, ${joiner}, '') AS name, COUNT(*)::text AS count
        FROM documents d
        ${scoped.sql ? `${scoped.sql} AND` : "WHERE"} ${expression} IS NOT NULL
        GROUP BY 1
        ORDER BY 1
        LIMIT 500
      `,
      [...scoped.params, JOINERS],
    );
    return result.rows.map((row) => ({ name: row.name, count: Number(row.count) }));
  };

  const total = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM documents d ${providerWhere.sql}`,
    providerWhere.params,
  );

  const tierCounts = await pool.query<{ tier: string; count: string }>(
    `SELECT COALESCE(d.tier, 'none') AS tier, COUNT(*)::text AS count FROM documents d ${scoped.sql} GROUP BY 1 ORDER BY 1`,
    scoped.params,
  );

  return {
    total: Number(total.rows[0]?.count ?? 0),
    departments: departments.rows.map((row) => ({
      key: row.key,
      names: row.names ?? [],
      count: Number(row.count),
    })),
    sections: await listOf(SECTION_SQL),
    categories: await listOf(CATEGORY_SQL),
    tiers: tierCounts.rows.map((row) => ({ tier: row.tier, count: Number(row.count) })),
  };
}
