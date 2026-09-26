"use client";

/**
 * Browse every archived order that matches the filters, like the Shasanadesh
 * portal's own search: department → section → category, GO number, subject
 * words and date range, newest first, with the total count and pages.
 *
 * This is a metadata listing (documents table), not semantic search: it shows
 * all matches, including orders whose text is not indexed yet.
 */

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SOURCE_COLLECTIONS, formatGoDate, sourceCollectionLabel } from "../lib/sources";

interface DepartmentFacet {
  key: string;
  names: string[];
  count: number;
}

interface Facets {
  total: number;
  departments: DepartmentFacet[];
  sections: Array<{ name: string; count: number }>;
  categories: Array<{ name: string; count: number }>;
  tiers?: Array<{ tier: string; count: number }>;
}

export interface BrowseRow {
  sourceId: string;
  provider: string;
  department: string | null;
  section: string | null;
  category: string | null;
  goNumber: string | null;
  goDate: string | null;
  goDateText: string | null;
  subject: string | null;
  pageCount: number | null;
  sourceUrl: string;
  indexed: boolean;
  inB2: boolean;
  tier: "A" | "B" | "C" | null;
  docType: string | null;
  classificationConfidence: "high" | "low" | null;
}

interface BrowseResult {
  total: number;
  page: number;
  pageSize: number;
  rows: BrowseRow[];
}

interface Filters {
  provider: string;
  departmentKey: string;
  section: string;
  category: string;
  goNumber: string;
  text: string;
  dateFrom: string;
  dateTo: string;
  mine: boolean;
  /** "", "A", "B", "C", "AB" (what Ask uses) or "none" (not classified). */
  tier: string;
}

const EMPTY: Filters = {
  provider: "",
  departmentKey: "",
  section: "",
  category: "",
  goNumber: "",
  text: "",
  dateFrom: "",
  dateTo: "",
  mine: false,
  tier: "",
};

const TIER_LABELS: Record<string, string> = {
  A: "A · generally applicable",
  B: "B · useful in context",
  C: "C · routine / individual",
  none: "Not classified yet",
};

/** Short badge text for a row's tier. */
const TIER_BADGE: Record<string, string> = { A: "Tier A", B: "Tier B", C: "Tier C" };

const tierFilter = (tier: string): string[] | undefined =>
  tier === "AB" ? ["A", "B"] : tier ? [tier] : undefined;

async function post<T>(action: "browse" | "facets", body: unknown): Promise<T> {
  const response = await fetch(`/api/rag/documents/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.text();
  if (!response.ok) {
    let message = payload.slice(0, 300);
    try {
      message = (JSON.parse(payload) as { error?: string }).error ?? message;
    } catch {
      // Not JSON; keep the raw text.
    }
    throw new Error(
      response.status >= 500 ? `${message}` : `The archive returned ${response.status}: ${message}`,
    );
  }
  return JSON.parse(payload) as T;
}

const departmentLabel = (facet: DepartmentFacet) =>
  facet.key === "none" ? "No department recorded" : facet.names.join(" · ") || facet.key;

/** Page numbers to show around the current page: 1 … 4 5 [6] 7 8 … 20. */
function pageWindow(current: number, last: number): Array<number | "gap"> {
  const pages = new Set([1, last, current - 2, current - 1, current, current + 1, current + 2]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= last).sort((a, b) => a - b);
  const result: Array<number | "gap"> = [];
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) result.push("gap");
    result.push(page);
  });
  return result;
}

export function BrowseOrders({
  scopeDepartments = [],
  onOpen,
}: {
  scopeDepartments?: string[];
  onOpen: (row: BrowseRow) => void;
}) {
  // `draft` is what the form shows; `applied` is what the table was loaded with.
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<"date_desc" | "date_asc">("date_desc");
  const [facets, setFacets] = useState<Facets | null>(null);
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  /** Page buttons sit below the table; bring the top of the list back into view. */
  const goToPage = (next: number) => {
    setPage(next);
    summaryRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  // Department, section and category lists follow the archive and department.
  useEffect(() => {
    let cancelled = false;
    post<Facets>("facets", {
      ...(draft.provider ? { providers: [draft.provider] } : {}),
      ...(draft.departmentKey ? { departmentKeys: [draft.departmentKey] } : {}),
    })
      .then((data) => {
        if (!cancelled) setFacets(data);
      })
      .catch(() => {
        // The listing call reports the error; facets are optional.
      });
    return () => {
      cancelled = true;
    };
  }, [draft.provider, draft.departmentKey]);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await post<BrowseResult>("browse", {
        ...(applied.provider ? { providers: [applied.provider] } : {}),
        ...(applied.departmentKey ? { departmentKeys: [applied.departmentKey] } : {}),
        ...(applied.mine && scopeDepartments.length ? { scopeDepartments } : {}),
        ...(applied.section ? { section: applied.section } : {}),
        ...(applied.category ? { category: applied.category } : {}),
        ...(applied.goNumber.trim() ? { goNumber: applied.goNumber.trim() } : {}),
        ...(applied.text.trim() ? { text: applied.text.trim() } : {}),
        ...(applied.dateFrom ? { dateFrom: applied.dateFrom } : {}),
        ...(applied.dateTo ? { dateTo: applied.dateTo } : {}),
        ...(tierFilter(applied.tier) ? { tiers: tierFilter(applied.tier) } : {}),
        page,
        pageSize,
        sort,
      });
      setResult(data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [applied, page, pageSize, sort, scopeDepartments]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = (next: Filters) => {
    setDraft(next);
    setApplied(next);
    setPage(1);
  };

  /** Drop-downs apply at once; typed fields wait for Enter / "Show orders". */
  const choose = (patch: Partial<Filters>) => apply({ ...draft, ...patch });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    apply(draft);
  };

  const activeCount = useMemo(
    () =>
      (Object.keys(EMPTY) as Array<keyof Filters>).filter((key) =>
        key === "mine" ? applied.mine : String(applied[key]).trim(),
      ).length,
    [applied],
  );

  const lastPage = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;
  const firstRow = result && result.total ? (result.page - 1) * result.pageSize + 1 : 0;
  const lastRow = result ? Math.min(result.total, result.page * result.pageSize) : 0;

  return (
    <section className="browse-orders" aria-label="Browse all orders">
      <form className="search-workbench browse-filters" onSubmit={submit}>
        <div className="retrieval-filters">
          <label>
            Archive
            <select value={draft.provider} onChange={(event) => choose({ provider: event.target.value, departmentKey: "", section: "", category: "" })}>
              <option value="">All archives</option>
              {SOURCE_COLLECTIONS.map((collection) => (
                <option key={collection.provider} value={collection.provider}>{collection.label}</option>
              ))}
            </select>
          </label>
          <label>
            Department
            <select
              value={draft.departmentKey}
              onChange={(event) => choose({ departmentKey: event.target.value, section: "", category: "", mine: false })}
            >
              <option value="">All departments{facets ? ` (${facets.total})` : ""}</option>
              {(facets?.departments ?? []).map((facet) => (
                <option key={facet.key} value={facet.key}>
                  {departmentLabel(facet)} ({facet.count})
                </option>
              ))}
            </select>
          </label>
          <label>
            Section
            <select
              value={draft.section}
              onChange={(event) => choose({ section: event.target.value })}
              disabled={!facets?.sections.length}
            >
              <option value="">All sections</option>
              {(facets?.sections ?? []).map((item) => (
                <option key={item.name} value={item.name}>{item.name} ({item.count})</option>
              ))}
            </select>
          </label>
          <label>
            Category
            <select value={draft.category} onChange={(event) => choose({ category: event.target.value })} disabled={!facets?.categories.length}>
              <option value="">All categories</option>
              {(facets?.categories ?? []).map((item) => (
                <option key={item.name} value={item.name}>{item.name} ({item.count})</option>
              ))}
            </select>
          </label>
          <label>
            Usefulness (tier)
            <select value={draft.tier} onChange={(event) => choose({ tier: event.target.value })}>
              <option value="">All tiers</option>
              <option value="AB">A + B · what Ask uses</option>
              {(facets?.tiers ?? []).map((item) => (
                <option key={item.tier} value={item.tier}>
                  {TIER_LABELS[item.tier] ?? item.tier} ({item.count})
                </option>
              ))}
            </select>
          </label>
          <label>
            GO / order number
            <input value={draft.goNumber} onChange={(event) => setDraft({ ...draft, goNumber: event.target.value })} placeholder="contains…" />
          </label>
          <label>
            Subject words
            <input value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} placeholder="e.g. वित्तीय स्वीकृति" />
          </label>
          <label>
            From date
            <input type="date" value={draft.dateFrom} onChange={(event) => choose({ dateFrom: event.target.value })} />
          </label>
          <label>
            To date
            <input type="date" value={draft.dateTo} onChange={(event) => choose({ dateTo: event.target.value })} />
          </label>
        </div>

        <div className="browse-actions">
          {scopeDepartments.length > 0 ? (
            <label className="browse-mine" title={scopeDepartments.join(", ")}>
              <input
                type="checkbox"
                checked={draft.mine}
                onChange={(event) => choose({ mine: event.target.checked, departmentKey: event.target.checked ? "" : draft.departmentKey })}
              />
              Only my departments ({scopeDepartments.length})
            </label>
          ) : <span />}
          <div className="browse-buttons">
            {activeCount > 0 ? (
              <button type="button" className="browse-clear" onClick={() => apply(EMPTY)}>
                Clear filters ({activeCount})
              </button>
            ) : null}
            <button type="submit" disabled={busy}>{busy ? "Loading…" : "Show orders"}</button>
          </div>
        </div>
      </form>

      <div className="search-summary browse-summary" ref={summaryRef}>
        <span>
          {result
            ? result.total
              ? `Showing ${firstRow.toLocaleString("en-IN")}–${lastRow.toLocaleString("en-IN")} of ${result.total.toLocaleString("en-IN")} orders`
              : "No orders match these filters"
            : busy ? "Loading orders…" : ""}
        </span>
        <span className="browse-view-options">
          <select aria-label="Sort" value={sort} onChange={(event) => { setSort(event.target.value as typeof sort); setPage(1); }}>
            <option value="date_desc">Newest first</option>
            <option value="date_asc">Oldest first</option>
          </select>
          <select aria-label="Rows per page" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
            {[25, 50, 100].map((size) => <option key={size} value={size}>{size} per page</option>)}
          </select>
        </span>
      </div>

      {error ? <div className="error-box">{error}</div> : null}

      {result && result.rows.length > 0 ? (
        <div className={`browse-table-wrap${busy ? " is-loading" : ""}`}>
          <table className="browse-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Date</th>
                <th scope="col">Department / section</th>
                <th scope="col">GO number</th>
                <th scope="col">Subject</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                <tr key={row.sourceId}>
                  <td className="browse-serial" data-label="#">{firstRow + index}</td>
                  <td className="browse-date" data-label="Date">
                    {formatGoDate(row.goDate) ?? row.goDateText ?? "—"}
                  </td>
                  <td data-label="Department">
                    <strong>{row.department ?? sourceCollectionLabel(row.sourceId)}</strong>
                    {row.section ? <span className="browse-sub">{row.section}</span> : null}
                    {row.category ? <span className="browse-sub browse-category">{row.category}</span> : null}
                  </td>
                  <td className="browse-go" data-label="GO number">
                    {row.goNumber ?? "—"}
                    <span className="browse-sub source-id">{row.sourceId}</span>
                  </td>
                  <td className="browse-subject" data-label="Subject">
                    {row.subject ?? <span className="browse-sub">No subject recorded</span>}
                    <span className="browse-flags">
                      <span className={row.indexed ? "badge badge-safe" : "badge"} title={row.indexed ? "Its text can be searched and asked about." : "Listed and archived, but its text is not indexed yet."}>
                        {row.indexed ? "Text indexed" : "Listed only"}
                      </span>
                      {row.tier ? (
                        <span
                          className={`badge tier-badge tier-${row.tier.toLowerCase()}`}
                          title={`${TIER_LABELS[row.tier]} · ${row.docType ?? "type unknown"}${row.classificationConfidence === "low" ? " · low confidence, needs review" : ""}`}
                        >
                          {TIER_BADGE[row.tier]}
                          {row.classificationConfidence === "low" ? " ?" : ""}
                        </span>
                      ) : null}
                      {row.docType ? <span className="browse-sub">{row.docType.replace(/-/g, " ")}</span> : null}
                      {row.pageCount ? <span className="browse-sub">{row.pageCount} p.</span> : null}
                    </span>
                  </td>
                  <td className="browse-open">
                    <button type="button" onClick={() => onOpen(row)}>View order</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {result && lastPage > 1 ? (
        <nav className="browse-pager" aria-label="Result pages">
          <button type="button" disabled={page <= 1 || busy} onClick={() => goToPage(page - 1)}>‹ Previous</button>
          {pageWindow(page, lastPage).map((item, index) =>
            item === "gap" ? (
              <span key={`gap-${index}`} className="browse-gap">…</span>
            ) : (
              <button
                type="button"
                key={item}
                className={item === page ? "active" : ""}
                aria-current={item === page ? "page" : undefined}
                disabled={busy}
                onClick={() => goToPage(item)}
              >
                {item}
              </button>
            ),
          )}
          <button type="button" disabled={page >= lastPage || busy} onClick={() => goToPage(page + 1)}>Next ›</button>
        </nav>
      ) : null}
    </section>
  );
}
