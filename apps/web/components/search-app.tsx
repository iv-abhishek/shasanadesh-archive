"use client";

import {
  FormEvent,
  Fragment,
  ReactNode,
  useMemo,
  useState,
} from "react";
import {
  SOURCE_COLLECTIONS,
  departmentKey,
  formatGoDate,
  looksGarbled,
  shasanadeshDepartmentId,
  sourceCollectionLabel,
} from "../lib/sources";
import { BrowseOrders, type BrowseRow } from "./browse-orders";

type VerificationStatus =
  | "conflict"
  | "ocr_only_unverified"
  | "variants_agree"
  | "native_primary"
  | "unverified"
  | string;

interface Evidence {
  label: string;
  source_id: string;
  document_title?: string | null;
  page_number: number;
  department: string | null;
  go_number: string | null;
  go_date: string | null;
  source_url: string;
  page_url: string;
  selected_variant: "native" | "ocr";
  selected_canonical: boolean;
  numeric_conflict: boolean;
  numeric_verification_status:
    VerificationStatus;
  rerank_score_raw: number;
  matched_chunk_text: string;
}

interface SearchResponse {
  evidence: Evidence[];
}

interface ViewerItem {
  label: string;
  sourceId: string;
  pageNumber: number;
  department: string | null;
  sourceUrl: string;
  pageUrl: string;
  /** Absent when the viewer is opened from the browse list (no page evidence). */
  verificationStatus?: VerificationStatus;
}

function statusLabel(
  status: VerificationStatus,
): string {
  switch (status) {
    case "conflict":
      return "Numeric conflict";
    case "ocr_only_unverified":
      return "OCR-only";
    case "variants_agree":
      return "Variants agree";
    case "native_primary":
      return "Native text";
    default:
      return "Unverified";
  }
}

function statusClass(
  status: VerificationStatus,
): string {
  if (
    status === "conflict" ||
    status === "ocr_only_unverified" ||
    status === "unverified"
  ) {
    return "badge badge-warning";
  }

  if (status === "native_primary") {
    return "badge badge-safe";
  }

  return "badge";
}

function pdfProxyUrl(
  item: ViewerItem,
): string {
  return (
    `/api/rag/pdf?sourceId=${encodeURIComponent(
      item.sourceId,
    )}` +
    `#page=${item.pageNumber}&zoom=page-width`
  );
}

function SearchViewer({
  item,
  onClose,
}: {
  item: ViewerItem;
  onClose: () => void;
}) {
  return (
    <div className="viewer-backdrop">
      <aside className="viewer-panel">
        <div className="viewer-header">
          <div>
            <div className="section-label">
              Source viewer
            </div>

            <div className="viewer-title">
              {item.department ?? "Government order"}
              {item.label ? ` · ${item.label}` : ""} · p.{item.pageNumber}
            </div>
          </div>

          <button
            type="button"
            className="viewer-close"
            onClick={onClose}
            aria-label="Close source viewer"
          >
            ×
          </button>
        </div>

        <div className="viewer-actions">
          {item.verificationStatus ? (
            <span className={statusClass(item.verificationStatus)}>
              {statusLabel(item.verificationStatus)}
            </span>
          ) : <span />}

          <a
            className="viewer-original"
            href={item.pageUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open original
          </a>
        </div>

        <iframe
          className="pdf-frame"
          src={pdfProxyUrl(item)}
          title={`${item.label} page ${item.pageNumber}`}
        />
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result shaping: one card per order, pages as chips, weaker matches folded.
// ---------------------------------------------------------------------------

interface OrderGroup {
  sourceId: string;
  /** Normalised department (or archive name when the order has none). */
  departmentKey: string;
  departmentLabel: string;
  title: string;
  subtitle: string[];
  pages: Evidence[];
  best: Evidence;
  score: number;
}

const RISKY = new Set(["conflict", "ocr_only_unverified", "unverified"]);

function groupByOrder(results: Evidence[]): OrderGroup[] {
  const groups = new Map<string, OrderGroup>();

  // Results arrive best-first, so the first page seen for an order is its best.
  for (const result of results) {
    const existing = groups.get(result.source_id);
    if (existing) {
      existing.pages.push(result);
      continue;
    }
    const collection = sourceCollectionLabel(result.source_id);
    // Orders are shown under their department, so the card title is the
    // order's own subject/title, falling back to its GO number or ID.
    const department = result.department?.trim() || null;
    const departmentId = shasanadeshDepartmentId(result.source_id);
    groups.set(result.source_id, {
      sourceId: result.source_id,
      departmentKey:
        departmentId !== null
          ? `shasanadesh-department:${departmentId}`
          : department
            ? departmentKey(department)
            : `archive:${collection}`,
      departmentLabel: department ?? collection,
      title:
        result.document_title?.trim() ||
        (result.go_number ? `GO ${result.go_number}` : `Order ${result.source_id}`),
      subtitle: [
        result.document_title && result.go_number ? `GO ${result.go_number}` : null,
        formatGoDate(result.go_date),
        collection,
      ].filter((value): value is string => Boolean(value)),
      pages: [result],
      best: result,
      score: result.rerank_score_raw,
    });
  }

  return [...groups.values()].map((group) => ({
    ...group,
    pages: [...group.pages].sort((a, b) => a.page_number - b.page_number),
  }));
}

/**
 * Split orders into close matches and weaker ones. The reranker returns either
 * probabilities (0–1) or raw logits depending on the model build, so the cut
 * is relative to the best result: below a quarter of the top probability, or
 * more than 3 logits behind it. A search always returns top-K pages; this keeps
 * clearly unrelated pages from looking like answers.
 */
function splitByRelevance(groups: OrderGroup[]): { strong: OrderGroup[]; weak: OrderGroup[] } {
  if (groups.length === 0) return { strong: [], weak: [] };
  const scores = groups.map((group) => group.score);
  const top = Math.max(...scores);
  const probabilities = scores.every((score) => score >= 0 && score <= 1);
  const isStrong = (score: number) =>
    probabilities ? score >= Math.max(0.05, top * 0.25) : score >= top - 3;
  const strong = groups.filter((group) => isStrong(group.score));
  // Never hide everything: the best order is always shown.
  return strong.length > 0
    ? { strong, weak: groups.filter((group) => !isStrong(group.score)) }
    : { strong: groups.slice(0, 1), weak: groups.slice(1) };
}

interface DepartmentSection {
  key: string;
  /** Every spelling seen for this department, e.g. "कृषि विभाग · Agriculture". */
  label: string;
  /** One name to search with; the filter widens it by department ID. */
  searchName: string;
  orders: OrderGroup[];
  pageCount: number;
}

/**
 * Group orders by department, keeping the relevance order: a department is
 * placed by its best order, and orders inside it stay best-first.
 */
function groupByDepartment(orders: OrderGroup[]): DepartmentSection[] {
  const sections = new Map<string, DepartmentSection & { names: Map<string, string> }>();
  for (const order of orders) {
    const section = sections.get(order.departmentKey) ?? {
      key: order.departmentKey,
      label: "",
      searchName: order.departmentLabel,
      orders: [],
      pageCount: 0,
      names: new Map<string, string>(),
    };
    section.orders.push(order);
    section.pageCount += order.pages.length;
    // Keep one spelling per name, ignoring zero-width joiners and case.
    const nameKey = departmentKey(order.departmentLabel);
    if (!section.names.has(nameKey)) section.names.set(nameKey, order.departmentLabel);
    sections.set(order.departmentKey, section);
  }
  return [...sections.values()].map(({ names, ...section }) => ({
    ...section,
    label: [...names.values()].join(" · "),
  }));
}

function orderStatus(pages: Evidence[]): { label: string; className: string } {
  const statuses = new Set(pages.map((page) => page.numeric_verification_status));
  if (statuses.size === 1) {
    const [status] = [...statuses];
    return { label: statusLabel(status), className: statusClass(status) };
  }
  return [...statuses].some((status) => RISKY.has(status))
    ? { label: "Mixed evidence", className: "badge badge-warning" }
    : { label: "Native text", className: "badge badge-safe" };
}

/** Terms worth highlighting: Latin words of 3+ letters, Devanagari words of 2+. */
function queryTerms(query: string): string[] {
  const words = query.toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((word) =>
    /[\u0900-\u097F]/.test(word) ? word.length >= 2 : word.length >= 3,
  ))];
}

/**
 * Chunks can start mid-word ("rovisions", a dangling matra). Drop that
 * fragment so the snippet starts on a whole word.
 */
function cleanSnippet(text: string): string {
  let snippet = text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  if (/^[\p{M}\u200C\u200D]/u.test(snippet) || /^[a-z]{1,12}[ ,.;:]/.test(snippet)) {
    const firstBreak = snippet.search(/\s/);
    if (firstBreak > 0 && firstBreak < 20) snippet = "…" + snippet.slice(firstBreak).trimStart();
  }
  return snippet;
}

function highlight(text: string, terms: string[]): ReactNode {
  if (terms.length === 0) return text;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escaped.join("|")})`, "giu");
  return text.split(pattern).map((part, index) =>
    index % 2 === 1 ? <mark key={index}>{part}</mark> : <Fragment key={index}>{part}</Fragment>,
  );
}

function OrderCard({
  group,
  terms,
  onOpen,
}: {
  group: OrderGroup;
  terms: string[];
  onOpen: (page: Evidence) => void;
}) {
  const status = orderStatus(group.pages);
  // Show the best-ranked page whose text layer is readable; a legacy-font page
  // would only show mojibake. Pages are in page order, so rank them first.
  const byRank = [group.best, ...group.pages.filter((page) => page !== group.best)];
  const readable = byRank.find((page) => !looksGarbled(page.matched_chunk_text));
  const snippetPage = readable ?? group.best;
  const snippet = cleanSnippet(snippetPage.matched_chunk_text);
  const garbled = !readable;

  return (
    <article className="search-result-card">
      <div className="search-result-head">
        <button type="button" className="search-result-title" onClick={() => onOpen(snippetPage)}>
          <strong>{group.title}</strong>
          {group.subtitle.length ? <span>{group.subtitle.join(" · ")}</span> : null}
        </button>
        <span className={status.className}>{status.label}</span>
      </div>

      {garbled ? (
        <p className="search-garbled-note">
          The text layer of p.{group.best.page_number} is damaged (old font encoding). Open the page to read it.
        </p>
      ) : (
        <p className="search-snippet">
          {snippetPage !== group.best ? (
            <span className="search-snippet-page">p.{snippetPage.page_number} · </span>
          ) : null}
          {highlight(snippet, terms)}
        </p>
      )}

      <div className="page-chips">
        {group.pages.map((page) => (
          <button
            type="button"
            key={page.page_number}
            className={[
              "page-chip",
              page === group.best ? "page-chip-cited" : "page-chip-direct",
              RISKY.has(page.numeric_verification_status) ? "page-chip-risky" : "",
            ].join(" ").trim()}
            title={`${statusLabel(page.numeric_verification_status)} · ${page.selected_variant.toUpperCase()} text — open page ${page.page_number}`}
            onClick={() => onOpen(page)}
          >
            p.{page.page_number}
          </button>
        ))}
        <span className="source-id">{group.sourceId}</span>
      </div>
    </article>
  );
}

function DepartmentSections({
  sections,
  terms,
  onOpen,
  onSearchWithin,
}: {
  sections: DepartmentSection[];
  terms: string[];
  onOpen: (page: Evidence) => void;
  onSearchWithin?: (department: string) => void;
}) {
  return (
    <>
      {sections.map((section) => (
        <section key={section.key} className="search-department" aria-label={section.label}>
          <header className="search-department-head">
            <h3>{section.label}</h3>
            <span className="search-department-count">
              {section.orders.length} order{section.orders.length === 1 ? "" : "s"} · {section.pageCount} page
              {section.pageCount === 1 ? "" : "s"}
            </span>
            {onSearchWithin && !section.key.startsWith("archive:") ? (
              <button
                type="button"
                className="search-within"
                onClick={() => onSearchWithin(section.searchName)}
                title={`Run this search again, only in ${section.label}`}
              >
                Search only here
              </button>
            ) : null}
          </header>
          <div className="search-result-list">
            {section.orders.map((group) => (
              <OrderCard key={group.sourceId} group={group} terms={terms} onOpen={onOpen} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export function SearchApp({
  scopeDepartments = [],
}: {
  /** The officer's departments, for the "My departments" scope. */
  scopeDepartments?: string[];
}) {
  /** "browse" lists every order matching the filters (portal-style); "search" ranks pages by meaning. */
  const [mode, setMode] = useState<"browse" | "search">("browse");
  const [query, setQuery] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [department, setDepartment] = useState("");
  const [goNumber, setGoNumber] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [verificationStatus, setVerificationStatus] = useState("");
  const [provider, setProvider] = useState("");
  const [results, setResults] = useState<Evidence[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [viewer, setViewer] = useState<ViewerItem | null>(null);
  /** Department chip selected in the results (client-side, no new search). */
  const [facet, setFacet] = useState<string | null>(null);

  const activeFilterCount = [provider, department, goNumber, sourceId, dateFrom, dateTo, verificationStatus]
    .filter((value) => value.trim()).length;
  const groups = useMemo(() => splitByRelevance(groupByOrder(results)), [results]);
  const facets = useMemo(
    () => groupByDepartment([...groups.strong, ...groups.weak]).map((section) => ({
      key: section.key,
      label: section.label,
      orders: section.orders.length,
    })),
    [groups],
  );
  const inFacet = (group: OrderGroup) => !facet || group.departmentKey === facet;
  const strongSections = useMemo(
    () => groupByDepartment(groups.strong.filter(inFacet)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, facet],
  );
  const weakSections = useMemo(
    () => groupByDepartment(groups.weak.filter(inFacet)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, facet],
  );
  const weakCount = weakSections.reduce((sum, section) => sum + section.orders.length, 0);
  const terms = useMemo(() => queryTerms(lastQuery), [lastQuery]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void runSearch();
  };

  /** "Search only here": rerun the same query filtered to one department. */
  const searchWithin = (departmentName: string) => {
    setDepartment(departmentName);
    void runSearch({ department: departmentName });
  };

  const runSearch = async (override: { department?: string } = {}) => {
    const trimmed = query.trim();
    if (!trimmed || busy) return;
    const departmentFilter = (override.department ?? department).trim();

    setBusy(true);
    setError(null);
    const started = performance.now();

    // An explicit department filter wins over the scope toggle.
    const filters = {
      ...(departmentFilter
        ? { department: departmentFilter }
        : scope === "mine" && scopeDepartments.length
          ? { departments: scopeDepartments }
          : {}),
      ...(provider ? { providers: [provider] } : {}),
      ...(goNumber.trim() ? { goNumber: goNumber.trim() } : {}),
      ...(sourceId.trim() ? { sourceId: sourceId.trim() } : {}),
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
      ...(verificationStatus ? { verificationStatus } : {}),
      // Internal console: search every order, including routine ones (tier C).
      includeRoutine: true,
    };

    try {
      const response = await fetch("/api/rag/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 24 pages (the reranked pool) so several departments can show up.
        body: JSON.stringify({ query: trimmed, topK: 24, filters }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          response.status >= 500 && /not reachable|ECONNREFUSED|fetch failed/i.test(body)
            ? "The search service is not running. Start the stack with npm run dev:all and try again."
            : `Search returned ${response.status}: ${body.slice(0, 300)}`,
        );
      }

      const data = (await response.json()) as SearchResponse;
      setResults(data.evidence);
      setFacet(null);
      setLastQuery(trimmed);
      setSearched(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setElapsedMs(performance.now() - started);
      setBusy(false);
    }
  };

  const open = (page: Evidence) =>
    setViewer({
      label: page.label,
      sourceId: page.source_id,
      pageNumber: page.page_number,
      department: page.document_title || page.department,
      sourceUrl: page.source_url,
      pageUrl: page.page_url,
      verificationStatus: page.numeric_verification_status,
    });

  const orderCount = groups.strong.length + groups.weak.length;

  const openOrder = (row: BrowseRow) =>
    setViewer({
      label: row.goNumber ? `GO ${row.goNumber}` : row.sourceId,
      sourceId: row.sourceId,
      pageNumber: 1,
      department: row.department,
      sourceUrl: row.sourceUrl,
      pageUrl: row.sourceUrl,
    });

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Uttar Pradesh Government Orders</div>
          <h1>Search Orders</h1>
        </div>
        <div className="topbar-note">{mode === "browse" ? "All orders · portal-style filters" : "Hybrid retrieval · database filters"}</div>
      </header>

      <div className="search-mode-tabs" role="tablist" aria-label="Search mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "browse"}
          className={mode === "browse" ? "active" : ""}
          onClick={() => setMode("browse")}
        >
          Browse all orders
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "search"}
          className={mode === "search" ? "active" : ""}
          onClick={() => setMode("search")}
        >
          Search inside orders
        </button>
      </div>

      {mode === "browse" ? (
        <>
          <section className="intro search-intro">
            <h2>Browse all archived orders.</h2>
            <p>
              Lists all orders that match the filters, newest first, like the Shasanadesh portal:
              department, section, category, GO number, subject words and dates. Orders appear here as
              soon as they are archived, even before their text is indexed for search.
            </p>
          </section>
          <BrowseOrders scopeDepartments={scopeDepartments} onOpen={openOrder} />
        </>
      ) : (
        <>
        <section className="intro search-intro">
          <h2>Search the archived orders directly.</h2>
          <p>
            Finds matching pages in Hindi or English and groups them by department, then by order.
            Filters are applied before matching, so a narrow filter can return fewer results.
          </p>
        </section>

        <form className="search-workbench" onSubmit={submit}>
          <div className="search-query-row">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search orders, rules or provisions… (Hindi or English)"
            />
            <button type="submit" disabled={busy || !query.trim()}>
              {busy ? "Searching…" : "Search"}
            </button>
          </div>

          <div className="search-options-row">
            {scopeDepartments.length > 0 ? (
              <div className="search-scope" role="group" aria-label="Search scope">
                <button
                  type="button"
                  className={scope === "all" ? "active" : ""}
                  aria-pressed={scope === "all"}
                  onClick={() => setScope("all")}
                >
                  All departments
                </button>
                <button
                  type="button"
                  className={scope === "mine" ? "active" : ""}
                  aria-pressed={scope === "mine"}
                  onClick={() => setScope("mine")}
                  title={scopeDepartments.join(", ")}
                >
                  My departments ({scopeDepartments.length})
                </button>
              </div>
            ) : <span />}
          </div>

          <details className="search-filters" open={activeFilterCount > 0 || undefined}>
            <summary>Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}</summary>
            <div className="retrieval-filters">
              <label>
                Archive
                <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                  <option value="">All archives</option>
                  {SOURCE_COLLECTIONS.map((collection) => (
                    <option key={collection.provider} value={collection.provider}>{collection.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Department
                <input value={department} onChange={(event) => setDepartment(event.target.value)} placeholder="e.g. Medical and Health" />
              </label>
              <label>
                GO / order number
                <input value={goNumber} onChange={(event) => setGoNumber(event.target.value)} placeholder="contains…" />
              </label>
              <label>
                Source ID
                <input value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="exact source id" />
              </label>
              <label>
                From date
                <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
              </label>
              <label>
                To date
                <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
              </label>
              <label>
                Evidence status
                <select value={verificationStatus} onChange={(event) => setVerificationStatus(event.target.value)}>
                  <option value="">Any</option>
                  <option value="native_primary">Native text</option>
                  <option value="variants_agree">Variants agree</option>
                  <option value="ocr_only_unverified">OCR-only</option>
                  <option value="conflict">Numeric conflict</option>
                  <option value="unverified">Unverified</option>
                </select>
              </label>
            </div>
          </details>
        </form>

        {searched || error ? (
          <div className="search-summary">
            <span>
              {orderCount} order{orderCount === 1 ? "" : "s"} · {results.length} page{results.length === 1 ? "" : "s"}
              {groups.weak.length ? ` · ${groups.strong.length} close match${groups.strong.length === 1 ? "" : "es"}` : ""}
            </span>
            {elapsedMs !== null ? <span>{(elapsedMs / 1000).toFixed(1)} s</span> : null}
          </div>
        ) : null}

        {error ? <div className="error-box">{error}</div> : null}

        {searched && !error && results.length === 0 ? (
          <div className="search-empty">No pages matched. Try fewer filters or the Hindi term.</div>
        ) : null}

        {facets.length > 1 ? (
          <div className="search-facets" role="group" aria-label="Filter results by department">
            <button
              type="button"
              className={facet === null ? "active" : ""}
              aria-pressed={facet === null}
              onClick={() => setFacet(null)}
            >
              All departments <span>{orderCount}</span>
            </button>
            {facets.map((item) => (
              <button
                type="button"
                key={item.key}
                className={facet === item.key ? "active" : ""}
                aria-pressed={facet === item.key}
                onClick={() => setFacet(facet === item.key ? null : item.key)}
              >
                {item.label} <span>{item.orders}</span>
              </button>
            ))}
          </div>
        ) : null}

        <DepartmentSections
          sections={strongSections}
          terms={terms}
          onOpen={open}
          onSearchWithin={department.trim() ? undefined : searchWithin}
        />

        {weakCount > 0 ? (
          <details className="search-weaker" open={strongSections.length === 0 || undefined}>
            <summary>
              {weakCount} less relevant order{weakCount === 1 ? "" : "s"}
            </summary>
            <DepartmentSections sections={weakSections} terms={terms} onOpen={open} />
          </details>
        ) : null}
        </>
      )}

      {viewer ? <SearchViewer item={viewer} onClose={() => setViewer(null)} /> : null}
    </main>
  );
}
