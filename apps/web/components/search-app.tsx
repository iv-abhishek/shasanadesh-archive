"use client";

import {
  FormEvent,
  useState,
} from "react";

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
    `/api/rag/pdf?url=${encodeURIComponent(
      item.sourceUrl,
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

export function SearchApp() {
  const [query, setQuery] =
    useState("");
  const [department, setDepartment] =
    useState("");
  const [goNumber, setGoNumber] =
    useState("");
  const [sourceId, setSourceId] =
    useState("");
  const [dateFrom, setDateFrom] =
    useState("");
  const [dateTo, setDateTo] =
    useState("");
  const [
    verificationStatus,
    setVerificationStatus,
  ] = useState("");

  const [results, setResults] =
    useState<Evidence[]>([]);
  const [busy, setBusy] =
    useState(false);
  const [error, setError] =
    useState<string | null>(null);
  const [elapsedMs, setElapsedMs] =
    useState<number | null>(null);
  const [viewer, setViewer] =
    useState<ViewerItem | null>(null);

  const submit =
    async (
      event: FormEvent,
    ) => {
      event.preventDefault();

      const trimmed =
        query.trim();

      if (!trimmed || busy) {
        return;
      }

      setBusy(true);
      setError(null);

      const started =
        performance.now();

      const filters = {
        ...(department.trim()
          ? {
              department:
                department.trim(),
            }
          : {}),
        ...(goNumber.trim()
          ? {
              goNumber:
                goNumber.trim(),
            }
          : {}),
        ...(sourceId.trim()
          ? {
              sourceId:
                sourceId.trim(),
            }
          : {}),
        ...(dateFrom
          ? { dateFrom }
          : {}),
        ...(dateTo
          ? { dateTo }
          : {}),
        ...(verificationStatus
          ? {
              verificationStatus,
            }
          : {}),
      };

      try {
        const response =
          await fetch(
            "/api/rag/search",
            {
              method: "POST",
              headers: {
                "content-type":
                  "application/json",
              },
              body:
                JSON.stringify({
                  query:
                    trimmed,
                  topK: 12,
                  filters,
                }),
            },
          );

        if (!response.ok) {
          throw new Error(
            `Search returned ${response.status}: ${await response.text()}`,
          );
        }

        const data =
          (await response.json()) as
            SearchResponse;

        setResults(
          data.evidence,
        );
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : String(caught),
        );
      } finally {
        setElapsedMs(
          performance.now() -
            started,
        );
        setBusy(false);
      }
    };

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">
            Uttar Pradesh
            Government Orders
          </div>

          <h1>
            Search Orders
          </h1>
        </div>

        <div className="topbar-note">
          Hybrid retrieval ·
          database filters
        </div>
      </header>

      <section className="intro search-intro">
        <h2>
          Search the archived page
          corpus directly.
        </h2>

        <p>
          Department, order number,
          source, date and evidence
          filters are applied before
          vector and lexical candidate
          generation.
        </p>
      </section>

      <form
        className="search-workbench"
        onSubmit={submit}
      >
        <div className="search-query-row">
          <input
            value={query}
            onChange={(event) =>
              setQuery(
                event.target.value,
              )
            }
            placeholder="Search orders, rules or provisions…"
          />

          <button
            type="submit"
            disabled={
              busy ||
              !query.trim()
            }
          >
            {busy
              ? "Searching…"
              : "Search"}
          </button>
        </div>

        <div className="retrieval-filters">
          <label>
            Department
            <input
              value={department}
              onChange={(event) =>
                setDepartment(
                  event.target.value,
                )
              }
              placeholder="e.g. Medical and Health"
            />
          </label>

          <label>
            GO / order number
            <input
              value={goNumber}
              onChange={(event) =>
                setGoNumber(
                  event.target.value,
                )
              }
              placeholder="contains…"
            />
          </label>

          <label>
            Source ID
            <input
              value={sourceId}
              onChange={(event) =>
                setSourceId(
                  event.target.value,
                )
              }
              placeholder="exact source id"
            />
          </label>

          <label>
            From date
            <input
              type="date"
              value={dateFrom}
              onChange={(event) =>
                setDateFrom(
                  event.target.value,
                )
              }
            />
          </label>

          <label>
            To date
            <input
              type="date"
              value={dateTo}
              onChange={(event) =>
                setDateTo(
                  event.target.value,
                )
              }
            />
          </label>

          <label>
            Evidence status
            <select
              value={
                verificationStatus
              }
              onChange={(event) =>
                setVerificationStatus(
                  event.target.value,
                )
              }
            >
              <option value="">
                Any
              </option>
              <option value="native_primary">
                Native text
              </option>
              <option value="variants_agree">
                Variants agree
              </option>
              <option value="ocr_only_unverified">
                OCR-only
              </option>
              <option value="conflict">
                Numeric conflict
              </option>
              <option value="unverified">
                Unverified
              </option>
            </select>
          </label>
        </div>
      </form>

      <div className="search-summary">
        <span>
          {results.length} results
        </span>

        {elapsedMs !== null ? (
          <span>
            {(
              elapsedMs / 1000
            ).toFixed(1)} s
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="error-box">
          {error}
        </div>
      ) : null}

      <section className="search-result-list">
        {results.map(
          (result) => (
            <button
              type="button"
              className="search-result-card"
              key={`${result.source_id}-${result.page_number}`}
              onClick={() =>
                setViewer({
                  label:
                    result.label,
                  pageNumber:
                    result.page_number,
                  department:
                    result.department,
                  sourceUrl:
                    result.source_url,
                  pageUrl:
                    result.page_url,
                  verificationStatus:
                    result
                      .numeric_verification_status,
                })
              }
            >
              <div className="search-result-head">
                <div>
                  <strong>
                    {result.department ??
                      "Unknown department"}
                  </strong>

                  <div className="source-id">
                    {result.source_id} · p.
                    {result.page_number}
                  </div>
                </div>

                <span
                  className={
                    statusClass(
                      result
                        .numeric_verification_status,
                    )
                  }
                >
                  {statusLabel(
                    result
                      .numeric_verification_status,
                  )}
                </span>
              </div>

              <p className="search-snippet">
                {
                  result.matched_chunk_text
                }
              </p>

              <div className="source-meta">
                {result.go_date ? (
                  <span>
                    {result.go_date}
                  </span>
                ) : null}

                {result.go_number ? (
                  <span>
                    GO{" "}
                    {result.go_number}
                  </span>
                ) : null}

                <span>
                  {result.selected_variant.toUpperCase()}
                </span>
              </div>
            </button>
          ),
        )}
      </section>

      {viewer ? (
        <SearchViewer
          item={viewer}
          onClose={() =>
            setViewer(null)
          }
        />
      ) : null}
    </main>
  );
}
