"use client";

import {
  FormEvent,
  Fragment,
  useMemo,
  useState,
} from "react";

type VerificationStatus =
  | "conflict"
  | "ocr_only_unverified"
  | "variants_agree"
  | "native_primary"
  | "unverified"
  | string;

interface Source {
  label: string;
  sourceId: string;
  pageNumber: number;
  department: string | null;
  goNumber: string | null;
  goDate: string | null;
  sourceUrl: string;
  pageUrl: string;
  numericConflict: boolean;
  numericVerificationStatus:
    VerificationStatus;
  selectedVariant:
    "native" | "ocr";
  selectedCanonical: boolean;
  rerankScoreRaw: number;
}

interface DoneEvent {
  ok?: boolean;
  validated?: boolean;
  repaired?: boolean;
  usedQualitativeSalvage?: boolean;
  usedFallback?: boolean;
  citations?: string[];
  firstValidationIssues?: string[];
  repairValidationIssues?: string[];
}

interface ChatTurn {
  id: number;
  question: string;
  answer: string;
  sources: Source[];
  done: DoneEvent | null;
  error: string | null;
  elapsedMs: number | null;
}

interface ViewerState {
  source: Source;
}

function pdfProxyUrl(source: Source): string {
  return (
    `/api/rag/pdf?url=${encodeURIComponent(source.sourceUrl)}` +
    `#page=${source.pageNumber}&zoom=page-width`
  );
}

const CHAT_API_PATH =
  "/api/rag/chat";

function parseSseBlock(
  block: string,
): {
  event: string;
  data: unknown;
} | null {
  let event = "";
  const dataLines: string[] = [];

  for (
    const line of
      block.split(/\r?\n/)
  ) {
    if (
      line.startsWith(
        "event:",
      )
    ) {
      event =
        line
          .slice(6)
          .trim();

      continue;
    }

    if (
      line.startsWith(
        "data:",
      )
    ) {
      dataLines.push(
        line
          .slice(5)
          .trimStart(),
      );
    }
  }

  if (!event) {
    return null;
  }

  const raw =
    dataLines.join("\n");

  let data: unknown =
    raw;

  if (raw) {
    try {
      data =
        JSON.parse(raw);
    } catch {
      // Keep raw text for diagnostics.
    }
  }

  return {
    event,
    data,
  };
}

function formatDuration(
  elapsedMs: number | null,
): string {
  if (elapsedMs === null) {
    return "";
  }

  if (elapsedMs < 1000) {
    return `${Math.round(
      elapsedMs,
    )} ms`;
  }

  return `${(
    elapsedMs / 1000
  ).toFixed(1)} s`;
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
    status ===
      "ocr_only_unverified" ||
    status === "unverified"
  ) {
    return "badge badge-warning";
  }

  if (
    status === "native_primary"
  ) {
    return "badge badge-safe";
  }

  return "badge";
}

function CitationText({
  text,
  sources,
  onOpenSource,
}: {
  text: string;
  sources: Source[];
  onOpenSource: (source: Source) => void;
}) {
  const byKey =
    useMemo(
      () =>
        new Map(
          sources.map(
            (source) => [
              `${source.label}:${source.pageNumber}`,
              source,
            ],
          ),
        ),
      [sources],
    );

  const pieces =
    text.split(
      /(\[S\d+\s+p\.\d+\])/g,
    );

  return (
    <>
      {pieces.map(
        (piece, index) => {
          const match =
            piece.match(
              /^\[(S\d+)\s+p\.(\d+)\]$/,
            );

          if (!match) {
            return (
              <Fragment
                key={`${index}-${piece.slice(0, 12)}`}
              >
                {piece}
              </Fragment>
            );
          }

          const source =
            byKey.get(
              `${match[1]}:${Number.parseInt(
                match[2],
                10,
              )}`,
            );

          if (!source) {
            return (
              <span
                className="citation citation-missing"
                key={`${index}-${piece}`}
              >
                {piece}
              </span>
            );
          }

          return (
            <button
              className="citation citation-button"
              type="button"
              onClick={() => onOpenSource(source)}
              title={`Open ${source.label}, page ${source.pageNumber}`}
              key={`${index}-${piece}`}
            >
              {piece}
            </button>
          );
        },
      )}
    </>
  );
}

function SourceCard({
  source,
  onOpenSource,
}: {
  source: Source;
  onOpenSource: (source: Source) => void;
}) {
  return (
    <button
      className="source-card source-card-button"
      type="button"
      onClick={() => onOpenSource(source)}
    >
      <div className="source-card-top">
        <strong>
          {source.label} · p.
          {source.pageNumber}
        </strong>

        <span
          className={
            statusClass(
              source
                .numericVerificationStatus,
            )
          }
        >
          {statusLabel(
            source
              .numericVerificationStatus,
          )}
        </span>
      </div>

      <div className="source-department">
        {source.department ??
          "Unknown department"}
      </div>

      <div className="source-meta">
        <span>
          {source.selectedVariant.toUpperCase()}
        </span>

        {source.goDate ? (
          <span>
            {source.goDate}
          </span>
        ) : null}

        {source.goNumber ? (
          <span>
            GO {source.goNumber}
          </span>
        ) : null}
      </div>

      <div className="source-id">
        {source.sourceId}
      </div>
    </button>
  );
}

function TurnView({
  turn,
  onOpenSource,
}: {
  turn: ChatTurn;
  onOpenSource: (source: Source) => void;
}) {
  return (
    <article className="turn">
      <div className="question-bubble">
        {turn.question}
      </div>

      <div className="answer-panel">
        <div className="answer-heading">
          <span>
            Answer
          </span>

          {turn.elapsedMs !==
          null ? (
            <span className="elapsed">
              {formatDuration(
                turn.elapsedMs,
              )}
            </span>
          ) : null}
        </div>

        {turn.error ? (
          <div className="error-box">
            {turn.error}
          </div>
        ) : (
          <div className="answer-text">
            {turn.answer ? (
              <CitationText
                text={turn.answer}
                sources={turn.sources}
                onOpenSource={onOpenSource}
              />
            ) : (
              <span className="muted">
                Retrieving evidence
                and generating a
                validated answer…
              </span>
            )}
          </div>
        )}

        {turn.done ? (
          <div className="answer-status">
            <span
              className={
                turn.done.validated
                  ? "badge badge-safe"
                  : "badge badge-warning"
              }
            >
              {turn.done.validated
                ? "Validated"
                : "Not validated"}
            </span>

            {turn.done.repaired ? (
              <span className="badge">
                Repaired
              </span>
            ) : null}

            {turn.done
              .usedQualitativeSalvage ? (
              <span className="badge badge-warning">
                Qualitative salvage
              </span>
            ) : null}

            {turn.done.usedFallback ? (
              <span className="badge badge-warning">
                Safe fallback
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {turn.sources.length >
      0 ? (
        <div className="sources-section">
          <div className="section-label">
            Sources
          </div>

          <div className="source-grid">
            {turn.sources.map(
              (source) => (
                <SourceCard
                  key={`${source.label}-${source.pageNumber}`}
                  source={source}
                  onOpenSource={onOpenSource}
                />
              ),
            )}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function SourceViewer({
  source,
  onClose,
}: {
  source: Source;
  onClose: () => void;
}) {
  return (
    <div className="viewer-backdrop">
      <aside className="viewer-panel">
        <div className="viewer-header">
          <div>
            <div className="section-label">Source viewer</div>
            <div className="viewer-title">
              {source.department ?? "Government order"} · {source.label} · p.{source.pageNumber}
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
          <span className={statusClass(source.numericVerificationStatus)}>
            {statusLabel(source.numericVerificationStatus)}
          </span>

          <a
            href={source.pageUrl}
            target="_blank"
            rel="noreferrer"
            className="viewer-original"
          >
            Open original
          </a>
        </div>

        <iframe
          className="pdf-frame"
          src={pdfProxyUrl(source)}
          title={`Source ${source.label} page ${source.pageNumber}`}
        />
      </aside>
    </div>
  );
}

export function ChatApp() {
  const [query, setQuery] =
    useState("");

  const [turns, setTurns] =
    useState<ChatTurn[]>([]);

  const [busy, setBusy] =
    useState(false);

  const [viewer, setViewer] =
    useState<ViewerState | null>(null);

  const openSource =
    (source: Source) => {
      setViewer({ source });
    };

  const submit =
    async (
      event: FormEvent,
    ) => {
      event.preventDefault();

      const question =
        query.trim();

      if (!question || busy) {
        return;
      }

      setBusy(true);
      setQuery("");

      const id =
        Date.now();

      const started =
        performance.now();

      const newTurn: ChatTurn = {
        id,
        question,
        answer: "",
        sources: [],
        done: null,
        error: null,
        elapsedMs: null,
      };

      setTurns(
        (current) => [
          ...current,
          newTurn,
        ],
      );

      const update =
        (
          updater:
            (
              turn: ChatTurn,
            ) => ChatTurn,
        ) => {
          setTurns(
            (current) =>
              current.map(
                (turn) =>
                  turn.id === id
                    ? updater(
                        turn,
                      )
                    : turn,
              ),
          );
        };

      try {
        const response =
          await fetch(
            CHAT_API_PATH,
            {
              method: "POST",
              headers: {
                "content-type":
                  "application/json",
              },
              body: JSON.stringify({
                messages: [
                  {
                    role: "user",
                    content:
                      question,
                  },
                ],
              }),
            },
          );

        if (!response.ok) {
          throw new Error(
            `API returned ${response.status}: ${await response.text()}`,
          );
        }

        if (!response.body) {
          throw new Error(
            "The API returned no response stream.",
          );
        }

        const reader =
          response.body.getReader();

        const decoder =
          new TextDecoder();

        let buffer = "";

        const processBlock =
          (block: string) => {
            const parsed =
              parseSseBlock(
                block,
              );

            if (!parsed) {
              return;
            }

            if (
              parsed.event ===
                "sources" &&
              Array.isArray(
                parsed.data,
              )
            ) {
              update(
                (turn) => ({
                  ...turn,
                  sources:
                    parsed.data as
                      Source[],
                }),
              );

              return;
            }

            if (
              parsed.event ===
                "token" &&
              parsed.data &&
              typeof parsed.data ===
                "object"
            ) {
              const text =
                (
                  parsed.data as {
                    text?: unknown;
                  }
                ).text;

              if (
                typeof text ===
                "string"
              ) {
                update(
                  (turn) => ({
                    ...turn,
                    answer:
                      turn.answer +
                      text,
                  }),
                );
              }

              return;
            }

            if (
              parsed.event ===
                "done" &&
              parsed.data &&
              typeof parsed.data ===
                "object"
            ) {
              update(
                (turn) => ({
                  ...turn,
                  done:
                    parsed.data as
                      DoneEvent,
                  elapsedMs:
                    performance.now() -
                    started,
                }),
              );

              return;
            }

            if (
              parsed.event ===
              "error"
            ) {
              let message =
                "Unknown API error";

              if (
                parsed.data &&
                typeof parsed.data ===
                  "object"
              ) {
                const candidate =
                  (
                    parsed.data as {
                      message?: unknown;
                    }
                  ).message;

                if (
                  typeof candidate ===
                    "string"
                ) {
                  message =
                    candidate;
                }
              }

              update(
                (turn) => ({
                  ...turn,
                  error:
                    message,
                  elapsedMs:
                    performance.now() -
                    started,
                }),
              );
            }
          };

        while (true) {
          const {
            value,
            done,
          } =
            await reader.read();

          if (done) {
            break;
          }

          buffer +=
            decoder.decode(
              value,
              {
                stream: true,
              },
            );

          const blocks =
            buffer.split(
              /\r?\n\r?\n/,
            );

          buffer =
            blocks.pop() ??
            "";

          for (
            const block of
              blocks
          ) {
            processBlock(
              block,
            );
          }
        }

        buffer +=
          decoder.decode();

        if (
          buffer.trim()
        ) {
          processBlock(
            buffer,
          );
        }
      } catch (error) {
        update(
          (turn) => ({
            ...turn,
            error:
              error instanceof
              Error
                ? error.message
                : String(error),
            elapsedMs:
              performance.now() -
              started,
          }),
        );
      } finally {
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
            Shasanadesh
            Assistant
          </h1>
        </div>

        <div className="topbar-note">
          Evidence-grounded ·
          page-cited · OCR-aware
        </div>
      </header>

      <section className="intro">
        <h2>
          Ask about an order,
          rule, department or
          administrative provision.
        </h2>

        <p>
          Answers are grounded in
          archived government-order
          pages. Open any citation
          to review the original
          source page.
        </p>
      </section>

      <section className="conversation">
        {turns.length === 0 ? (
          <div className="empty-state">
            <div>
              Try a current
              benchmark question:
            </div>

            <div className="suggestions">
              <button
                type="button"
                onClick={() =>
                  setQuery(
                    "medical officer seniority",
                  )
                }
              >
                medical officer
                seniority
              </button>

              <button
                type="button"
                onClick={() =>
                  setQuery(
                    "सोलर पम्प",
                  )
                }
              >
                सोलर पम्प
              </button>
            </div>
          </div>
        ) : (
          turns.map(
            (turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                onOpenSource={openSource}
              />
            ),
          )
        )}
      </section>

      <form
        className="composer"
        onSubmit={submit}
      >
        <textarea
          value={query}
          onChange={(event) =>
            setQuery(
              event.target.value,
            )
          }
          placeholder="Ask in English or Hindi…"
          rows={3}
          disabled={busy}
          onKeyDown={(
            event,
          ) => {
            if (
              event.key ===
                "Enter" &&
              !event.shiftKey
            ) {
              event.preventDefault();

              event.currentTarget
                .form
                ?.requestSubmit();
            }
          }}
        />

        <button
          type="submit"
          disabled={
            busy ||
            !query.trim()
          }
        >
          {busy
            ? "Working…"
            : "Ask"}
        </button>
      </form>

      <footer className="footer-note">
        Critical dates, amounts,
        percentages, rule numbers,
        levels and identifiers may
        require verification against
        the original PDF page when
        OCR evidence is uncertain.
      </footer>

      {viewer ? (
        <SourceViewer
          source={viewer.source}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </main>
  );
}
