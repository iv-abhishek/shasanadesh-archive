/**
 * Later changes to retrieved orders (ADR-054).
 *
 * After retrieval, look up document_relations for later orders that
 * supersede / amend / cancel / correct an order in the evidence. A relation
 * matches an evidence order either by its resolved target_source_id or by
 * number key + date (so links still work for orders that were listed but not
 * archived when relations:build ran).
 *
 * Two consumers:
 *   - the prompt: a digit-free LATER_CHANGES line per evidence block, so the
 *     model warns that a provision may not be current without writing numbers
 *     the numeric validator cannot check against the cited page;
 *   - the UI: exact GO number/date in the `sources` event, shown as a notice.
 *
 * A missing table (migration 008 not applied) means "no links known", never
 * an error for the user.
 */

import type { Pool } from "pg";
import { toIsoGoDate } from "../lib/go-date.js";
import { goKey } from "../relations/extract.js";
import type { RetrievalEvidence } from "./types.js";

export type ChangeKind = "supersedes" | "amends" | "cancels" | "corrects";

export interface LaterChange {
  kind: ChangeKind;
  bySourceId: string;
  byGoNumber: string | null;
  byGoDate: string | null;
}

/** Stronger kinds first; one entry per changing order. */
const KIND_ORDER: ChangeKind[] = ["cancels", "supersedes", "amends", "corrects"];
const MAX_PER_ORDER = 3;

export async function findLaterChanges(
  pool: Pick<Pool, "query">,
  evidence: RetrievalEvidence[],
): Promise<Map<string, LaterChange[]>> {
  const orders = new Map<string, { key: string; date: string }>();
  for (const item of evidence) {
    if (orders.has(item.source_id)) continue;
    orders.set(item.source_id, {
      key: (item.go_number && goKey(item.go_number)) || "",
      date: toIsoGoDate(item.go_date) ?? "",
    });
  }
  const result = new Map<string, LaterChange[]>();
  if (!orders.size) return result;

  let rows: Array<{ target: string; source_id: string; kind: ChangeKind; source_go_number: string | null; source_go_date: string | null }>;
  try {
    ({ rows } = await pool.query(
      `
      SELECT t.source_id AS target, r.source_id, r.kind, r.source_go_number,
             to_char(r.source_go_date, 'YYYY-MM-DD') AS source_go_date
      FROM unnest($1::text[], $2::text[], $3::text[]) AS t(source_id, go_key, go_date)
      JOIN document_relations r
        ON r.kind IN ('supersedes', 'amends', 'cancels', 'corrects')
       AND r.source_id <> t.source_id
       AND (
         r.target_source_id = t.source_id
         OR (t.go_key <> '' AND t.go_date <> ''
             AND r.target_go_key = t.go_key AND r.target_go_date = t.go_date::date)
       )
      ORDER BY r.source_go_date DESC NULLS LAST
      `,
      [[...orders.keys()], [...orders.values()].map((o) => o.key), [...orders.values()].map((o) => o.date)],
    ));
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return result; // table not created yet
    throw error;
  }

  for (const row of rows) {
    const list = result.get(row.target) ?? [];
    const existing = list.find((change) => change.bySourceId === row.source_id);
    if (existing) {
      if (KIND_ORDER.indexOf(row.kind) < KIND_ORDER.indexOf(existing.kind)) existing.kind = row.kind;
      continue;
    }
    list.push({ kind: row.kind, bySourceId: row.source_id, byGoNumber: row.source_go_number, byGoDate: row.source_go_date });
    result.set(row.target, list);
  }
  for (const [target, list] of result) {
    result.set(target, list.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)).slice(0, MAX_PER_ORDER));
  }
  return result;
}

const KIND_PHRASE: Record<ChangeKind, string> = {
  cancels: "cancelled by",
  supersedes: "superseded by",
  amends: "amended by",
  corrects: "corrected by",
};

/**
 * Digit-free prompt line for one evidence order, or null when nothing is known.
 * A changing order that is itself in the evidence is named by its label.
 */
export function laterChangesPromptLine(
  changes: LaterChange[] | undefined,
  labelsBySourceId: Map<string, string>,
): string | null {
  if (!changes?.length) return null;
  return changes
    .map((change) => {
      const label = labelsBySourceId.get(change.bySourceId);
      return `${KIND_PHRASE[change.kind]} ${label ? `SOURCE ${label}` : "a later order that is not in this evidence"}`;
    })
    .join("; ");
}
