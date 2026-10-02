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
  /**
   * Finder terms (ADR-058), all required: exact phrases, and patterns where `*`
   * is any run of characters and `?` one character. Matched against subject,
   * section, category and GO number.
   */
  phrases?: string[];
  patterns?: string[];
  /** GO number starting with this ("51/2026" finds 51/2026/918/…). */
  goNumberPrefix?: string;
  /** Issuing section (अनुभाग) containing this text. */
  sectionLike?: string;
  /** ADR-064: jurisdiction codes ("IN", "UP", …) and topic codes; any of each. */
  jurisdictions?: string[];
  topics?: string[];
  /** Rulebook §2: leave out documents flagged as non-government (Ask always sets this). */
  governmentOnly?: boolean;
  /** Only these orders (e.g. subject-similarity hits), still subject to the other filters. */
  sourceIds?: string[];
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
  /** True once the order has searchable chunks (text indexed for Ask/Search). */
  indexed: boolean;
  inB2: boolean;
  /** Classifier result (npm run classify:orders); null until classified. */
  tier: "A" | "B" | "C" | null;
  docType: string | null;
  classificationConfidence: "high" | "low" | null;
  /** ADR-064 grouping. */
  jurisdictionCode: string | null;
  authority: string | null;
  topics: string[];
  status: string;
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

// Everything a finder term may match: subject, section, category and number.
const SEARCHABLE_SQL =
  `COALESCE(${SUBJECT_SQL}, '') || ' ' || COALESCE(${SECTION_SQL}, '') || ' ' || ` +
  `COALESCE(${CATEGORY_SQL}, '') || ' ' || COALESCE(d.go_number, '')`;

function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * A section as typed ("कृषि अनुभाग-5", "अनुभाग 1") → a Postgres regex that
 * ignores spacing and dash style but not the number ("अनुभाग-1" ≠ "अनुभाग-12").
 */
export function sectionRegex(section: string): string {
  const text = clean(section).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let regex = text.replace(/\s*[-–]\s*/g, "\\s*[-–]?\\s*").replace(/ (?=\d)/g, "\\s*[-–]?\\s*").replace(/ /g, "\\s+");
  if (/\d$/.test(text)) regex += "([^0-9]|$)";
  return regex;
}

/** User wildcards → LIKE: `*` any run, `?` one character; everything else literal. */
export function wildcardToLike(pattern: string): string {
  return likeEscape(pattern).replace(/\*+/g, "%").replace(/\?/g, "_");
}

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
  if (filters.goNumberPrefix?.trim()) {
    // Spaces and zero-width joiners are not significant in GO numbers ("51 / 2026").
    const prefix = likeEscape(filters.goNumberPrefix.replace(/[\s\u200c\u200d]+/g, ""));
    clauses.push(`translate(replace(d.go_number, ' ', ''), ${param(JOINERS)}, '') ILIKE ${param(`${prefix}%`)}`);
  }
  if (filters.sectionLike?.trim()) {
    clauses.push(`translate(COALESCE(${SECTION_SQL}, ''), ${param(JOINERS)}, '') ~* ${param(sectionRegex(filters.sectionLike))}`);
  }
  if (filters.governmentOnly) clauses.push("d.provenance_ok");
  const jurisdictions = (filters.jurisdictions ?? []).map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code));
  if (jurisdictions.length) clauses.push(`d.jurisdiction_code = ANY(${param(jurisdictions)})`);
  const topics = (filters.topics ?? []).filter((topic) => /^[a-z-]{2,40}$/.test(topic));
  if (topics.length) clauses.push(`d.topics && ${param(topics)}::text[]`);
  const sourceIds = (filters.sourceIds ?? []).filter(Boolean).slice(0, 200);
  if (filters.sourceIds) clauses.push(`d.source_id = ANY(${param(sourceIds)})`);

  // Finder terms: phrases and wildcard patterns over subject, section, category, number.
  const finderTerms = [
    ...(filters.phrases ?? []).map((phrase) => `%${likeEscape(clean(phrase))}%`),
    ...(filters.patterns ?? []).map((pattern) => `%${wildcardToLike(clean(pattern))}%`),
  ].filter((term) => term.replace(/%/g, "").length > 0).slice(0, 8);
  if (finderTerms.length) {
    const joiners = param(JOINERS);
    for (const term of finderTerms) {
      clauses.push(`translate(${SEARCHABLE_SQL}, ${joiners}, '') ILIKE ${param(term)}`);
    }
  }

  // Every word must appear somewhere in the subject/title, section, category or GO number.
  const words = clean(filters.text ?? "").split(" ").filter(Boolean).slice(0, 8);
  if (words.length) {
    const joiners = param(JOINERS);
    for (const word of words) {
      const escaped = word.replace(/[\\%_]/g, (character) => `\\${character}`);
      clauses.push(
        `translate(${SEARCHABLE_SQL}, ${joiners}, '') ILIKE ${param(`%${escaped}%`)}`,
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
        -- "Indexed" = has searchable chunks (pages alone are not searchable).
        EXISTS (SELECT 1 FROM chunks c WHERE c.source_id = d.source_id) AS indexed,
        (d.metadata->'storage'->'raw'->>'fileId') IS NOT NULL AS in_b2,
        d.tier,
        d.doc_type,
        d.classification->>'confidence' AS classification_confidence,
        d.jurisdiction_code,
        d.authority,
        d.topics,
        d.status
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
      jurisdictionCode: row.jurisdiction_code ?? null,
      authority: row.authority ?? null,
      topics: row.topics ?? [],
      status: row.status ?? "current",
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
  /** ADR-064: documents per jurisdiction and per topic group (bilingual names). */
  jurisdictions: Array<{ code: string; nameEn: string; nameHi: string; count: number }>;
  topics: Array<{ code: string; nameEn: string; nameHi: string; count: number }>;
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

  // Before migration 011 the tables do not exist: empty groups, not an error.
  const jurisdictionCounts = await pool
    .query<{ code: string; name_en: string; name_hi: string; count: string }>(
      `SELECT j.code, j.name_en, j.name_hi, COUNT(d.source_id)::text AS count
       FROM jurisdictions j LEFT JOIN documents d ON d.jurisdiction_code = j.code
       WHERE j.active GROUP BY j.code, j.name_en, j.name_hi, j.level ORDER BY j.level, j.code`,
    )
    .catch(() => ({ rows: [] as Array<{ code: string; name_en: string; name_hi: string; count: string }> }));
  const topicCounts = await pool
    .query<{ code: string; name_en: string; name_hi: string; count: string }>(
      `SELECT t.code, t.name_en, t.name_hi, COUNT(d.source_id)::text AS count
       FROM topics t LEFT JOIN documents d ON t.code = ANY(d.topics)
       GROUP BY t.code, t.name_en, t.name_hi, t.sort_order ORDER BY t.sort_order`,
    )
    .catch(() => ({ rows: [] as Array<{ code: string; name_en: string; name_hi: string; count: string }> }));

  return {
    jurisdictions: jurisdictionCounts.rows.map((row) => ({ code: row.code, nameEn: row.name_en, nameHi: row.name_hi, count: Number(row.count) })),
    topics: topicCounts.rows.map((row) => ({ code: row.code, nameEn: row.name_en, nameHi: row.name_hi, count: Number(row.count) })),
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
