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
  formatGoDate,
  looksGarbled,
  sourceCollectionLabel,
} from "../lib/sources";

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
  verificationStatus:
    VerificationStatus;
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
              {item.department ??
                "Government order"}{" "}
              · {item.label} · p.
              {item.pageNumber}
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
          <span
            className={
              statusClass(
                item.verificationStatus,
              )
            }
          >
            {statusLabel(
              item.verificationStatus,
            )}
          </span>

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
    groups.set(result.source_id, {
      sourceId: result.source_id,
      title: result.document_title || result.department || collection,
      subtitle: [
        result.document_title && result.department ? result.department : null,
        result.go_number ? `GO ${result.go_number}` : null,
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
  const snippet = cleanSnippet(group.best.matched_chunk_text);
  const garbled = looksGarbled(snippet);

  return (
    <article className="search-result-card">
      <div className="search-result-head">
        <button type="button" className="search-result-title" onClick={() => onOpen(group.best)}>
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
        <p className="search-snippet">{highlight(snippet, terms)}</p>
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

export function SearchApp({
  scopeDepartments = [],
}: {
  /** The officer's departments, for the "My departments" scope. */
  scopeDepartments?: string[];
}) {
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

  const activeFilterCount = [provider, department, goNumber, sourceId, dateFrom, dateTo, verificationStatus]
    .filter((value) => value.trim()).length;
  const groups = useMemo(() => splitByRelevance(groupByOrder(results)), [results]);
  const terms = useMemo(() => queryTerms(lastQuery), [lastQuery]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError(null);
    const started = performance.now();

    // An explicit department filter wins over the scope toggle.
    const filters = {
      ...(department.trim()
        ? { department: department.trim() }
        : scope === "mine" && scopeDepartments.length
          ? { departments: scopeDepartments }
          : {}),
      ...(provider ? { providers: [provider] } : {}),
      ...(goNumber.trim() ? { goNumber: goNumber.trim() } : {}),
      ...(sourceId.trim() ? { sourceId: sourceId.trim() } : {}),
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
      ...(verificationStatus ? { verificationStatus } : {}),
    };

    try {
      const response = await fetch("/api/rag/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: trimmed, topK: 12, filters }),
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

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Uttar Pradesh Government Orders</div>
          <h1>Search Orders</h1>
        </div>
        <div className="topbar-note">Hybrid retrieval · database filters</div>
      </header>

      <section className="intro search-intro">
        <h2>Search the archived orders directly.</h2>
        <p>
          Finds matching pages in Hindi or English and groups them by order. Filters are applied
          before matching, so a narrow filter can return fewer results.
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

      <section className="search-result-list">
        {groups.strong.map((group) => (
          <OrderCard key={group.sourceId} group={group} terms={terms} onOpen={open} />
        ))}
      </section>

      {groups.weak.length > 0 ? (
        <details className="search-weaker">
          <summary>
            {groups.weak.length} less relevant order{groups.weak.length === 1 ? "" : "s"}
          </summary>
          <section className="search-result-list">
            {groups.weak.map((group) => (
              <OrderCard key={group.sourceId} group={group} terms={terms} onOpen={open} />
            ))}
          </section>
        </details>
      ) : null}

      {viewer ? <SearchViewer item={viewer} onClose={() => setViewer(null)} /> : null}
    </main>
  );
}
