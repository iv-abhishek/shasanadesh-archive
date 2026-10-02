"use client";

import type { ReactNode } from "react";
import {
  FormEvent,
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  appDayKey,
  formatAppDateTimeFull,
  formatAppDay,
  formatAppTime,
} from "../lib/app-time";
import {
  describeLaterChange,
  formatGoDate,
  officialShasanadeshUrl,
  readLaterChanges,
  sourceCollectionLabel,
  type LaterChange,
} from "../lib/sources";
import { formatGoReference } from "../lib/go-reference";
import { SearchGuide, StartPanel } from "./start-panel";
import { isGovernmentUrl } from "../lib/government-hosts";
import {
  convertFinishedWord,
  convertTrailingWord,
  undoConversion,
  wordAtCaret,
  type Conversion,
} from "../lib/transliterate";
import { useHindiTransliterator } from "../lib/use-hindi-typing";

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
  documentTitle?: string | null;
  pageNumber: number;
  department: string | null;
  goNumber: string | null;
  goDate: string | null;
  /** Official government URLs only (Rulebook §1); null when there is none. */
  sourceUrl: string | null;
  pageUrl: string | null;
  numericConflict: boolean;
  numericVerificationStatus:
    VerificationStatus;
  selectedVariant:
    "native" | "ocr";
  selectedCanonical: boolean;
  rerankScoreRaw: number;
  matchedChunkText?: string;  retrievalRole?:
    | "direct"
    | "neighbor";
  anchorPageNumber?:
    number | null;
  /** Later orders that supersede / amend / cancel / correct this one (ADR-054). */
  laterChanges?: LaterChange[];
  /** "listing": an entry of an order list (ADR-057), not a retrieved page. */
  kind?: "listing";
  /** ADR-064: "IN" (Government of India), "UP", …; and current / superseded / draft. */
  jurisdictionCode?: string | null;
  status?: string | null;
  /** The official copy is in a Kruti Dev font; the text shown was converted (ADR-070). */
  legacyFont?: boolean;
}

interface RagTimings {
  retrievalMs?: number;
  embeddingMs?: number | null;
  hybridSearchMs?: number | null;
  rerankMs?: number | null;
  hydrationMs?: number | null;
  retrievalServiceMs?: number | null;
  generationMs?: number;
  repairMs?: number;
  validationMs?: number;
  totalMs?: number;
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
  conversational?: boolean;
  intent?: string;
  retrievalScope?: string;
  timings?: RagTimings;
  /** No archived order answers the question; sources are not shown. */
  noEvidence?: boolean;
  noEvidenceReason?: "no_relevant_pages" | "model_found_no_answer";
  /** Nothing close in the officer's departments, so all departments were searched. */
  scopeFallback?: boolean;
  /** The answer hit the length limit and was cut back to its last full sentence. */
  shortened?: boolean;
  /** Best reranker relevance (0–1) among direct pages, for calibration. */
  bestRelevance?: number;
  /** Answered from the order list (ADR-057): dates, numbers and subjects as recorded. */
  listing?: boolean;
  /** A search for particular orders (ADR-058) rather than a dated list. */
  find?: boolean;
  listingTotal?: number;

}

interface ChatTurn {
  id: number;
  question: string;
  answer: string;
  sources: Source[];
  done: DoneEvent | null;
  error: string | null;
  /** The person pressed Stop before the answer was finished (ADR-059). */
  stopped?: boolean;
  elapsedMs: number | null;
  status?: string | null;
  /** When the question was asked (ms since epoch). */
  askedAt?: number;
  /** Saved assistant message, used for feedback and regenerate. */
  assistantMessageId?: string | null;
  feedback?: TurnFeedback | null;
  /**
   * Unchecked first draft streamed while the model writes. Shown muted and
   * replaced by the validated answer; never saved or copied.
   */
  draft?: string;
}

interface ChatAppProps {
  workspaceUserId?: string;
  conversationId?: string | null;
  archived?: boolean;
  onRestoreArchived?: () => void;
  onHistoryChanged?: () => void;
  preferredLanguage?: "en" | "hi";
}

interface SpeechRecognitionAlternative {
  transcript: string;
}

interface SpeechRecognitionResult {
  0?: SpeechRecognitionAlternative;
  isFinal: boolean;
  length: number;
}

interface SpeechRecognitionResultEvent {
  results: ArrayLike<SpeechRecognitionResult>;
}

interface SpeechRecognitionErrorEvent {
  error: string;
}

interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

interface SpeechRecognitionWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

interface PersistedMessage {
  id: string;
  role:
    | "user"
    | "assistant";
  content: string;
  sources: unknown[];
  metadata:
    Record<string, unknown>;
  createdAt: string;
  feedback?: TurnFeedback | null;
}

interface PersistedConversationResponse {
  messages:
    PersistedMessage[];
}



/** "Government of India" / "Uttar Pradesh" (ADR-064). */
function jurisdictionName(code: string, language: "hi" | "en"): string {
  const names: Record<string, [string, string]> = {
    IN: ["Government of India", "भारत सरकार"],
    UP: ["Uttar Pradesh", "उत्तर प्रदेश"],
  };
  const pair = names[code];
  return pair ? (language === "hi" ? pair[1] : pair[0]) : code;
}

/** The official URL for a cited page (#page=N), or null when there is no government link. */
function officialPageUrl(source: Source): string | null {
  if (source.pageUrl && isGovernmentUrl(source.pageUrl)) return source.pageUrl;
  if (source.sourceUrl && isGovernmentUrl(source.sourceUrl)) return `${source.sourceUrl.split("#")[0]}#page=${source.pageNumber}`;
  return null;
}

const CHAT_API_PATH =
  "/api/rag/chat";

const START_HINT =
  "Start all services with: npm run dev:all";

// Turn low-level failures into a message that names the service to start.
function describeServiceError(message: string): string {
  const lower = message.toLowerCase();

  if (lower.includes("retrieval service")) {
    return `The retrieval service (port 8788) is not responding. ${START_HINT}`;
  }

  if (
    lower.includes("language model server") ||
    lower.includes("connection error")
  ) {
    return `The language model server (port 8791) is not responding. ${START_HINT}`;
  }

  if (lower.includes("5432") || lower.includes("database")) {
    return "PostgreSQL is not reachable. Start it (for example: brew services start postgresql@16), then retry.";
  }

  return message;
}

async function describeHttpFailure(response: Response): Promise<string> {
  const text = await response.text();
  let message = text;

  try {
    const payload = JSON.parse(text) as { message?: unknown; error?: unknown };
    if (typeof payload.message === "string") message = payload.message;
    else if (typeof payload.error === "string") message = payload.error;
  } catch {
    // Plain-text body.
  }

  // 502 comes from the Next.js proxy when the API on :8787 is down.
  if (response.status === 502) {
    return `The answer API (port 8787) is not running. ${START_HINT}`;
  }

  const friendly = describeServiceError(message);
  return friendly !== message
    ? friendly
    : `Request failed (${response.status}): ${message || response.statusText}`;
}

function describeFetchFailure(error: unknown): string {
  // A TypeError from fetch means the browser could not reach this app at all.
  if (error instanceof TypeError) {
    return `Can't reach the Shasanadesh app server. ${START_HINT}, then retry.`;
  }

  return error instanceof Error
    ? describeServiceError(error.message)
    : String(error);
}

function appendSpeechTranscriptSegment(current: string, next: string): string {
  const segment = next.replace(/\s+/gu, " ").trim();
  if (!segment) return current;

  const previous = current.replace(/\s+$/u, "");
  if (!previous) return segment;
  if (/^[,.;:!?।॥…%)\]}»”’]/u.test(segment)) return previous + segment;
  if (/[([{«“‘]$/u.test(previous)) return previous + segment;
  return previous + " " + segment;
}

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

const VALIDATION_ISSUE_LABELS: Record<string, string> = {
  empty_answer: "The draft was empty",
  missing_citation: "A statement had no page citation",
  invalid_citation: "A citation pointed to a page that was not retrieved",
  uncited_numeric_claim: "A number was given without a citation",
  unsafe_numeric_claim:
    "A number came from a page whose native and OCR text disagree",
  unsupported_numeric_claim: "A number does not appear on the cited page",
  internal_placeholder: "The draft contained an internal placeholder",
};

function summarizeValidationIssues(
  codes: string[] | undefined,
): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();

  for (const code of codes ?? []) {
    const label = VALIDATION_ISSUE_LABELS[code] ?? code.replace(/_/g, " ");
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return [...counts].map(([label, count]) => ({ label, count }));
}

function SafetyCheckDetails({ done }: { done: DoneEvent }) {
  const first = summarizeValidationIssues(done.firstValidationIssues);
  const afterRepair = summarizeValidationIssues(done.repairValidationIssues);

  if (first.length === 0 && afterRepair.length === 0) return null;

  const outcome = done.usedFallback
    ? "The repaired draft still failed, so a safe fallback was shown instead."
    : done.usedQualitativeSalvage
      ? "Only the statements that passed the checks were kept."
      : done.repaired
        ? "The draft was repaired and the repaired answer passed."
        : null;

  return (
    <details className="timing-details safety-details">
      <summary>Why the safety check stepped in</summary>
      <div className="safety-issue-block">
        <span className="safety-issue-heading">First draft</span>
        <ul>
          {first.map((issue) => (
            <li key={issue.label}>
              {issue.label}
              {issue.count > 1 ? ` (${issue.count}×)` : ""}
            </li>
          ))}
        </ul>
      </div>
      {afterRepair.length > 0 ? (
        <div className="safety-issue-block">
          <span className="safety-issue-heading">After repair</span>
          <ul>
            {afterRepair.map((issue) => (
              <li key={issue.label}>
                {issue.label}
                {issue.count > 1 ? ` (${issue.count}×)` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {outcome ? <p className="safety-outcome">{outcome}</p> : null}
    </details>
  );
}

function formatStageMs(
  value:
    number | null | undefined,
): string {
  if (
    value === null ||
    value === undefined
  ) {
    return "-";
  }

  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }

  return `${(value / 1000).toFixed(1)} s`;
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

async function workspaceJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response =
    await fetch(
      url,
      {
        ...init,
        cache: "no-store",
      },
    );

  if (!response.ok) {
    throw new Error(
      `Workspace ${response.status}: ${await response.text()}`,
    );
  }

  return (
    await response.json()
  ) as T;
}

function normalizePersistedSource(
  value: unknown,
): Source | null {
  if (
    !value ||
    typeof value !==
      "object"
  ) {
    return null;
  }

  const raw =
    value as
      Record<
        string,
        unknown
      >;

  if (
    typeof raw.label !==
      "string" ||
    typeof raw.sourceId !==
      "string" ||
    typeof raw.pageNumber !==
      "number"
  ) {
    return null;
  }

  return {
    label:
      raw.label,
    sourceId:
      raw.sourceId,
    pageNumber:
      raw.pageNumber,
    department:
      typeof raw.department ===
        "string"
        ? raw.department
        : null,
    goNumber:
      typeof raw.goNumber ===
        "string"
        ? raw.goNumber
        : null,
    goDate:
      typeof raw.goDate ===
        "string"
        ? raw.goDate
        : null,
    sourceUrl:
      typeof raw.sourceUrl ===
        "string"
        ? raw.sourceUrl
        : "",
    pageUrl:
      typeof raw.pageUrl ===
        "string"
        ? raw.pageUrl
        : "",
    numericConflict:
      Boolean(
        raw.numericConflict,
      ),
    numericVerificationStatus:
      typeof raw
        .numericVerificationStatus ===
        "string"
        ? raw
            .numericVerificationStatus
        : "unverified",
    selectedVariant:
      raw.selectedVariant ===
        "ocr"
        ? "ocr"
        : "native",
    selectedCanonical:
      Boolean(
        raw.selectedCanonical,
      ),
    rerankScoreRaw:
      typeof raw
        .rerankScoreRaw ===
        "number"
        ? raw.rerankScoreRaw
        : 0,
    matchedChunkText:
      typeof raw
        .matchedChunkText ===
        "string"
        ? raw
            .matchedChunkText
        : undefined,
    // Keep retrieval provenance when a saved conversation is reopened so
    // neighbour pages are not shown as direct hits.
    documentTitle:
      typeof raw.documentTitle === "string"
        ? raw.documentTitle
        : null,
    retrievalRole:
      raw.retrievalRole === "neighbor"
        ? "neighbor"
        : "direct",
    anchorPageNumber:
      typeof raw.anchorPageNumber ===
        "number"
        ? raw.anchorPageNumber
        : null,
    laterChanges: readLaterChanges(raw.laterChanges),
    kind: raw.kind === "listing" ? "listing" : undefined,
    jurisdictionCode: typeof raw.jurisdictionCode === "string" ? raw.jurisdictionCode : null,
    status: typeof raw.status === "string" ? raw.status : null,
    legacyFont: raw.legacyFont === true,
  };
}

function turnsFromPersistedMessages(
  messages:
    PersistedMessage[],
): ChatTurn[] {
  const turns:
    ChatTurn[] = [];

  let pending:
    ChatTurn | null =
    null;

  for (
    const message of messages
  ) {
    if (
      message.role ===
      "user"
    ) {
      if (pending) {
        turns.push(
          pending,
        );
      }

      pending = {
        askedAt:
          Date.parse(message.createdAt) || undefined,
        id:
          Date.parse(
            message.createdAt,
          ) ||
          Date.now(),
        question:
          message.content,
        answer: "",
        sources: [],
        done: null,
        error: null,
        elapsedMs: null,
      };

      continue;
    }

    if (!pending) {
      continue;
    }

    const done =
      message.metadata &&
      typeof message.metadata ===
        "object"
        ? (
            message.metadata as
              DoneEvent
          )
        : null;

    pending.answer =
      message.content;

    pending.sources =
      message.sources
        .map(
          normalizePersistedSource,
        )
        .filter(
          (
            source,
          ): source is Source =>
            source !== null,
        );

    pending.done =
      done;

    pending.assistantMessageId =
      message.id;

    pending.feedback =
      message.feedback ?? null;

    turns.push(
      pending,
    );

    pending = null;
  }

  if (pending) {
    turns.push(
      pending,
    );
  }

  return turns;
}

function dominantSourceState(
  sources: Source[],
): {
  activeSourceId?: string;
  activeDepartment?: string;
} {
  const counts =
    new Map<
      string,
      {
        count: number;
        department:
          string | null;
      }
    >();

  for (
    const source of sources
  ) {
    const current =
      counts.get(
        source.sourceId,
      );

    counts.set(
      source.sourceId,
      {
        count:
          (current?.count ??
            0) + 1,
        department:
          current?.department ??
          source.department,
      },
    );
  }

  const selected =
    [...counts.entries()]
      .sort(
        (
          left,
          right,
        ) =>
          right[1].count -
          left[1].count,
      )[0];

  if (!selected) {
    return {};
  }

  return {
    activeSourceId:
      selected[0],
    activeDepartment:
      selected[1]
        .department ??
      undefined,
  };
}

function deriveConversationState(
  turns: ChatTurn[],
): {
  activeSourceId?: string;
  activeDepartment?: string;
} | undefined {
  const priorTurn =
    [...turns]
      .reverse()
      .find(
        (turn) =>
          !turn.error &&
          Boolean(
            turn.answer.trim(),
          ) &&
          turn.sources.length >
            0,
      );

  if (!priorTurn) {
    return undefined;
  }

  const counts =
    new Map<
      string,
      {
        count: number;
        department:
          string | null;
      }
    >();

  for (
    const source of
      priorTurn.sources
  ) {
    const current =
      counts.get(
        source.sourceId,
      );

    counts.set(
      source.sourceId,
      {
        count:
          (current?.count ?? 0) +
          1,
        department:
          current?.department ??
          source.department,
      },
    );
  }

  const ranked =
    [...counts.entries()]
      .sort(
        (
          left,
          right,
        ) =>
          right[1].count -
          left[1].count,
      );

  const selected =
    ranked[0];

  if (!selected) {
    return undefined;
  }

  return {
    activeSourceId:
      selected[0],
    activeDepartment:
      selected[1]
        .department ??
      undefined,
  };
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

// ---------------------------------------------------------------------------
// Live progress while an answer is being prepared.
// ---------------------------------------------------------------------------

function ProgressIndicator({
  label,
  startedAt,
}: {
  label: string | null | undefined;
  startedAt: number;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));

  return (
    <div className="answer-progress" role="status" aria-live="polite">
      <span className="progress-spinner" aria-hidden="true" />
      <span className="progress-label">
        {label ?? "Connecting"}…
      </span>
      <span className="progress-elapsed">{seconds}s</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Answer formatting: paragraphs, bullet / numbered lists, headings and bold,
// with [S# p.#] citations kept clickable. Deliberately small: generated text
// is rendered as React nodes, never as raw HTML.
// ---------------------------------------------------------------------------

type AnswerBlock =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "heading"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "numbers"; items: string[] };

const BULLET_RE = /^\s*[-*•–]\s+(.*)$/u;
const NUMBER_RE = /^\s*\d{1,2}[.)]\s+(.*)$/u;
const HEADING_RE = /^\s*#{1,4}\s+(.*)$/u;

function parseAnswerBlocks(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];

  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    const last = blocks[blocks.length - 1];

    if (!line.trim()) {
      blocks.push({ kind: "paragraph", lines: [] });
      continue;
    }

    const heading = line.match(HEADING_RE);
    const bullet = line.match(BULLET_RE);
    const numbered = line.match(NUMBER_RE);

    if (heading) {
      blocks.push({ kind: "heading", text: heading[1] });
    } else if (bullet) {
      if (last?.kind === "bullets") last.items.push(bullet[1]);
      else blocks.push({ kind: "bullets", items: [bullet[1]] });
    } else if (numbered) {
      if (last?.kind === "numbers") last.items.push(numbered[1]);
      else blocks.push({ kind: "numbers", items: [numbered[1]] });
    } else if (last?.kind === "paragraph") {
      last.lines.push(line.trim());
    } else {
      blocks.push({ kind: "paragraph", lines: [line.trim()] });
    }
  }

  return blocks.filter(
    (block) => block.kind !== "paragraph" || block.lines.length > 0,
  );
}

function InlineText({
  text,
  sources,
  onOpenSource,
}: {
  text: string;
  sources: Source[];
  onOpenSource: (source: Source) => void;
}) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);

  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
          <strong key={index}>
            <CitationText
              text={part.slice(2, -2)}
              sources={sources}
              onOpenSource={onOpenSource}
            />
          </strong>
        ) : (
          <CitationText
            key={index}
            text={part}
            sources={sources}
            onOpenSource={onOpenSource}
          />
        ),
      )}
    </>
  );
}

function FormattedAnswer({
  text,
  sources,
  onOpenSource,
}: {
  text: string;
  sources: Source[];
  onOpenSource: (source: Source) => void;
}) {
  const blocks = useMemo(() => parseAnswerBlocks(text), [text]);
  const inline = (value: string) => (
    <InlineText text={value} sources={sources} onOpenSource={onOpenSource} />
  );

  return (
    <div className="formatted-answer">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return <h4 key={index}>{inline(block.text)}</h4>;
          case "bullets":
            return (
              <ul key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{inline(item)}</li>
                ))}
              </ul>
            );
          case "numbers":
            return (
              <ol key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{inline(item)}</li>
                ))}
              </ol>
            );
          default:
            return (
              <p key={index}>
                {block.lines.map((line, lineIndex) => (
                  <Fragment key={lineIndex}>
                    {lineIndex > 0 ? <br /> : null}
                    {inline(line)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sources grouped by order: one card per document with page chips.
// Cited pages come first, then other direct hits; neighbouring context pages
// are collapsed behind "+N nearby".
// ---------------------------------------------------------------------------

const RISKY_STATUSES = new Set([
  "conflict",
  "ocr_only_unverified",
  "unverified",
]);

function citedKeys(answer: string): Set<string> {
  const keys = new Set<string>();
  for (const match of answer.matchAll(/\[(S\d+)\s+p\.(\d+)\]/g)) {
    keys.add(`${match[1]}:${Number.parseInt(match[2], 10)}`);
  }
  return keys;
}

interface SourceGroup {
  sourceId: string;
  title: string;
  subtitle: string[];
  laterChanges: LaterChange[];
  pages: Array<Source & { cited: boolean }>;
  anyCited: boolean;
}

function groupSources(sources: Source[], answer: string): SourceGroup[] {
  const cited = citedKeys(answer);
  const groups = new Map<string, SourceGroup>();

  for (const source of sources) {
    let group = groups.get(source.sourceId);

    if (!group) {
      const collection = sourceCollectionLabel(source.sourceId);
      const subtitle = [
        source.documentTitle && source.department ? source.department : null,
        source.goNumber ? `GO ${source.goNumber}` : null,
        formatGoDate(source.goDate),
        // Shasanadesh is the default archive; name the others.
        collection === "Shasanadesh" ? null : collection,
      ].filter((value): value is string => Boolean(value));

      group = {
        sourceId: source.sourceId,
        title:
          source.documentTitle ||
          source.department ||
          collection,
        subtitle,
        laterChanges: source.laterChanges ?? [],
        pages: [],
        anyCited: false,
      };
      groups.set(source.sourceId, group);
    }

    const isCited = cited.has(`${source.label}:${source.pageNumber}`);
    group.pages.push({ ...source, cited: isCited });
    group.anyCited ||= isCited;
  }

  const rank = (page: Source & { cited: boolean }) =>
    page.cited ? 0 : page.retrievalRole === "neighbor" ? 2 : 1;

  return [...groups.values()]
    .map((group) => ({
      ...group,
      pages: [...group.pages].sort(
        (left, right) =>
          rank(left) - rank(right) || left.pageNumber - right.pageNumber,
      ),
    }))
    .sort((left, right) => Number(right.anyCited) - Number(left.anyCited));
}

function evidenceSummary(pages: Source[]): { label: string; className: string } {
  const statuses = new Set(pages.map((page) => page.numericVerificationStatus));

  if (statuses.size === 1) {
    const [status] = [...statuses];
    return { label: statusLabel(status), className: statusClass(status) };
  }

  return [...statuses].some((status) => RISKY_STATUSES.has(status))
    ? { label: "Mixed evidence", className: "badge badge-warning" }
    : { label: "Native text", className: "badge badge-safe" };
}

function SourceGroupCard({
  group,
  language,
  onOpenSource,
}: {
  group: SourceGroup;
  /** Language of the answer; the reference line is written in it. */
  language: "hi" | "en";
  onOpenSource: (source: Source) => void;
}) {
  const [showNearby, setShowNearby] = useState(false);
  const [copied, setCopied] = useState(false);
  const first = group.pages[0];
  // Every page carries the order's metadata; take the first value recorded.
  const pick = <K extends "goNumber" | "goDate" | "documentTitle" | "department">(key: K) =>
    group.pages.map((page) => page[key]).find((value) => Boolean(value)) ?? null;
  const reference = first
    ? formatGoReference(
        {
          sourceId: group.sourceId,
          goNumber: pick("goNumber"),
          goDate: pick("goDate"),
          documentTitle: pick("documentTitle"),
          department: pick("department"),
        },
        language,
      )
    : null;
  // Citations point to the issuing government site, not to our archived copy.
  const officialUrl = first && isGovernmentUrl(first.sourceUrl) ? first.sourceUrl : null;

  const copyReference = async () => {
    if (!reference) return;
    try {
      await copyToClipboard(reference);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  const mainPages = group.pages.filter(
    (page) => page.cited || page.retrievalRole !== "neighbor",
  );
  const nearbyPages = group.pages.filter(
    (page) => !page.cited && page.retrievalRole === "neighbor",
  );
  const summary = evidenceSummary(group.pages);
  const mixed = new Set(group.pages.map((page) => page.numericVerificationStatus)).size > 1;

  const chip = (page: Source & { cited: boolean }) => {
    const role = page.cited
      ? "Cited in the answer"
      : page.retrievalRole === "neighbor"
        ? `Next to p.${page.anchorPageNumber ?? "?"}`
        : "Matched your question";

    return (
      <button
        type="button"
        key={`${page.label}-${page.pageNumber}`}
        className={[
          "page-chip",
          page.cited ? "page-chip-cited" : page.retrievalRole === "neighbor" ? "page-chip-nearby" : "page-chip-direct",
          mixed && RISKY_STATUSES.has(page.numericVerificationStatus) ? "page-chip-risky" : "",
        ].join(" ").trim()}
        title={`${page.label} · ${role} · ${statusLabel(page.numericVerificationStatus)} — open page ${page.pageNumber} on the official site`}
        onClick={() => onOpenSource(page)}
      >
        p.{page.pageNumber}
        <small>{page.label}</small>
      </button>
    );
  };

  return (
    <section className={group.anyCited ? "source-group source-group-cited" : "source-group"}>
      <div className="source-group-head">
        <div className="source-group-title">
          <strong>{group.title}</strong>
          {group.subtitle.length ? (
            <span>{group.subtitle.join(" · ")}</span>
          ) : null}
        </div>
        {first?.kind === "listing" ? null : <span className={summary.className}>{summary.label}</span>}
      </div>

      {first?.jurisdictionCode || (first?.status && first.status !== "current") ? (
        <div className="source-tags">
          {first.jurisdictionCode ? (
            <span className={first.jurisdictionCode === "IN" ? "source-tag source-tag-central" : "source-tag"}>
              {jurisdictionName(first.jurisdictionCode, language)}
            </span>
          ) : null}
          {first.status === "superseded" ? (
            <span className="source-tag source-tag-warning">{language === "hi" ? "अतिक्रमित" : "Superseded"}</span>
          ) : first.status === "draft" ? (
            <span className="source-tag source-tag-warning">{language === "hi" ? "प्रारूप" : "Draft"}</span>
          ) : null}
        </div>
      ) : null}

      {group.laterChanges.length ? (
        <ul className="source-later-changes" aria-label="Later changes to this order">
          {group.laterChanges.map((change) => {
            const href = officialShasanadeshUrl(change.bySourceId);
            const text = describeLaterChange(change, language);
            return (
              <li key={change.bySourceId}>
                <span aria-hidden="true">⚠</span>{" "}
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">{text} ↗</a>
                ) : (
                  text
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {group.pages.some((page) => page.legacyFont) ? (
        <p className="source-font-note">
          {language === "hi"
            ? "मूल प्रति कृति देव फ़ॉन्ट में है; यहाँ उसका पाठ यूनिकोड हिंदी में बदला गया है। यह फ़ॉन्ट न होने पर आधिकारिक प्रति अस्पष्ट दिख सकती है।"
            : "The original is typed in the Kruti Dev font; its text here was converted to Unicode Hindi. Without that font, the official copy may look garbled."}
        </p>
      ) : null}

      <div className="page-chips">
        {mainPages.map(chip)}
        {nearbyPages.length > 0 && !showNearby ? (
          <button
            type="button"
            className="page-chip page-chip-more"
            onClick={() => setShowNearby(true)}
          >
            +{nearbyPages.length} nearby
          </button>
        ) : null}
        {showNearby ? nearbyPages.map(chip) : null}
      </div>

      <div className="source-group-foot">
        {reference ? (
          <button
            type="button"
            className="source-reference"
            onClick={copyReference}
            title={`Copy for your letter: ${reference}`}
          >
            {copied ? "Copied ✓" : language === "hi" ? "संदर्भ कॉपी करें" : "Copy reference"}
          </button>
        ) : null}
        {officialUrl ? (
          <a className="source-official" href={officialUrl} target="_blank" rel="noreferrer">
            {language === "hi" ? "आधिकारिक प्रति ↗" : "Official copy ↗"}
          </a>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Hindi typing suggestions (ADR-061): alternatives for the word being typed,
 * plus the English letters as typed. Clicking one puts it in place of the word.
 */
function HindiTypingBar({
  query,
  caret,
  transliterator,
  onChoose,
}: {
  query: string;
  caret: number;
  transliterator: import("../lib/transliterate").Transliterator | null;
  onChoose: (start: number, end: number, text: string) => void;
}) {
  const current = wordAtCaret(query, caret);
  const choices = current && transliterator
    ? [...new Set([...transliterator.suggest(current.latin, 3), ...transliterator.complete(current.latin, 2)])].slice(0, 4)
    : [];

  return (
    <div className="hindi-typing-bar" aria-live="polite">
      <span className="hindi-typing-label" lang="hi">हिंदी</span>
      {current && choices.length ? (
        <>
          {choices.map((choice, index) => (
            <button
              type="button"
              key={choice}
              className={index === 0 ? "hindi-choice hindi-choice-first" : "hindi-choice"}
              lang="hi"
              title={index === 0 ? "Space also chooses this" : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChoose(current.start, caret, choice)}
            >
              {choice}
            </button>
          ))}
          <button
            type="button"
            className="hindi-choice hindi-choice-latin"
            title="Keep the English letters"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(current.start, caret, current.latin)}
          >
            {current.latin}
          </button>
        </>
      ) : (
        <span className="hindi-typing-hint">
          Type in English letters; Space turns the word into Devanagari · Backspace right after undoes it ·
          acronyms (GO, PWD) and numbers stay as typed
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Answer actions: copy, listen, feedback and regenerate.
// ---------------------------------------------------------------------------

type FeedbackRating = "up" | "down";

interface TurnFeedback {
  rating: FeedbackRating;
  reason: string | null;
  comment: string | null;
}

const FEEDBACK_REASONS: Array<{ value: string; label: string }> = [
  { value: "incorrect", label: "Incorrect information" },
  { value: "wrong_citation", label: "Wrong page or citation" },
  { value: "not_relevant", label: "Not relevant" },
  { value: "incomplete", label: "Incomplete" },
  { value: "too_slow", label: "Too slow" },
  { value: "other", label: "Other" },
];

function formatTurnTime(timestamp: number): { short: string; full: string; iso: string } {
  const date = new Date(timestamp);
  const now = new Date();
  const time = formatAppTime(date);
  const dayKey = appDayKey(date);
  const todayKey = appDayKey(now);

  return {
    short: dayKey === todayKey
      ? time
      : `${formatAppDay(date, dayKey.slice(0, 4) !== todayKey.slice(0, 4))}, ${time}`,
    full: formatAppDateTimeFull(date),
    iso: date.toISOString(),
  };
}

// Plain text for the clipboard: the answer without markdown emphasis, followed
// by the cited pages so the copy stands on its own in a note or file.
function answerCopyText(turn: ChatTurn): string {
  const answer = turn.answer.replace(/\*\*([^*]+)\*\*/g, "$1").trim();
  const cited = citedKeys(turn.answer);
  const seen = new Set<string>();
  const lines = turn.sources
    .filter((source) => cited.has(`${source.label}:${source.pageNumber}`))
    .filter((source) => {
      const key = `${source.label}:${source.pageNumber}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // Rulebook §1: the reference and the official link, never an internal ID.
    .map((source) => {
      const reference = formatGoReference(source, /[\u0900-\u097F]/.test(answer) ? "hi" : "en");
      const title = source.documentTitle || source.department || "";
      const url = officialPageUrl(source);
      return `[${source.label} p.${source.pageNumber}] ${reference}${title && !reference.includes(title) ? ` — ${title}` : ""}${url ? `\n    ${url}` : ""}`;
    });

  return lines.length > 0 ? `${answer}\n\nSources:\n${lines.join("\n")}` : answer;
}

// Text for speech: citations, markdown and list markers removed.
function answerSpeechText(answer: string): string {
  return answer
    .replace(/\[S\d+\s+p\.\d+\]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*(?:[-*•–]|\d{1,2}[.)])\s+/gmu, "")
    .replace(/\s+([.,;:।])/gu, "$1")
    // Line breaks become sentence pauses, without doubling punctuation.
    .replace(/([.!?।:;])\s*\n+/gu, "$1 ")
    .replace(/\n+/g, ". ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function speechLanguageFor(text: string): "hi-IN" | "en-IN" {
  const devanagari = (text.match(/[ऀ-ॿ]/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return devanagari > latin ? "hi-IN" : "en-IN";
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

const ActionIcon = {
  copy: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
  ),
  listen: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6L8 10H4Z" /><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11" /></svg>
  ),
  stop: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
  ),
  up: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11v9H4v-9h3Zm0 0 4-7a2 2 0 0 1 3 1.7V10h4.6a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.4 20H7" /></svg>
  ),
  down: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 13V4H4v9h3Zm0 0 4 7a2 2 0 0 0 3-1.7V14h4.6a2 2 0 0 0 2-2.3l-1.2-6A2 2 0 0 0 17.4 4H7" /></svg>
  ),
  regenerate: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>
  ),
};

function AnswerActions({
  turn,
  copied,
  speaking,
  speechSupported,
  canRegenerate,
  onCopy,
  onListen,
  onFeedback,
  onRegenerate,
}: {
  turn: ChatTurn;
  copied: boolean;
  speaking: boolean;
  speechSupported: boolean;
  canRegenerate: boolean;
  onCopy: () => void;
  onListen: () => void;
  onFeedback: (rating: FeedbackRating | null, reason?: string | null, comment?: string | null) => void;
  onRegenerate: () => void;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(turn.feedback?.reason ?? null);
  const [comment, setComment] = useState(turn.feedback?.comment ?? "");
  const [thanks, setThanks] = useState(false);
  const rating = turn.feedback?.rating ?? null;
  const conversational = Boolean(turn.done?.conversational);

  const vote = (next: FeedbackRating) => {
    if (rating === next) {
      onFeedback(null);
      setPanelOpen(false);
      return;
    }
    onFeedback(next);
    setThanks(next === "up");
    setPanelOpen(next === "down");
    if (next === "up") window.setTimeout(() => setThanks(false), 2500);
  };

  return (
    <div className="answer-actions-wrap">
      <div className="answer-actions" role="toolbar" aria-label="Answer actions">
        <button type="button" className="answer-action" onClick={onCopy} title={copied ? "Copied" : "Copy answer with sources"} aria-label={copied ? "Copied" : "Copy answer"}>
          {copied ? ActionIcon.check : ActionIcon.copy}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>

        {speechSupported ? (
          <button type="button" className={speaking ? "answer-action active" : "answer-action"} onClick={onListen} aria-pressed={speaking} title={speaking ? "Stop reading aloud" : "Read the answer aloud"} aria-label={speaking ? "Stop listening" : "Listen"}>
            {speaking ? ActionIcon.stop : ActionIcon.listen}
            <span>{speaking ? "Stop" : "Listen"}</span>
          </button>
        ) : null}

        {!conversational ? (
          <>
            <span className="answer-action-divider" aria-hidden="true" />
            <button type="button" className={rating === "up" ? "answer-action icon-only active" : "answer-action icon-only"} onClick={() => vote("up")} aria-pressed={rating === "up"} title="Good answer" aria-label="Good answer">
              {ActionIcon.up}
            </button>
            <button type="button" className={rating === "down" ? "answer-action icon-only active negative" : "answer-action icon-only"} onClick={() => vote("down")} aria-pressed={rating === "down"} title="Bad answer" aria-label="Bad answer">
              {ActionIcon.down}
            </button>
          </>
        ) : null}

        {canRegenerate && !conversational ? (
          <button type="button" className="answer-action" onClick={onRegenerate} title="Ask again for a new answer" aria-label="Regenerate answer">
            {ActionIcon.regenerate}
            <span>Regenerate</span>
          </button>
        ) : null}

        {thanks ? <span className="answer-action-note" role="status">Thanks for the feedback</span> : null}
      </div>

      {panelOpen ? (
        <div className="feedback-panel" role="group" aria-label="What was wrong with this answer?">
          <div className="feedback-panel-title">What was wrong? <span>(optional)</span></div>
          <div className="feedback-reasons">
            {FEEDBACK_REASONS.map((option) => (
              <button
                type="button"
                key={option.value}
                className={reason === option.value ? "feedback-reason active" : "feedback-reason"}
                aria-pressed={reason === option.value}
                onClick={() => setReason(reason === option.value ? null : option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <textarea
            className="feedback-comment"
            rows={2}
            maxLength={1000}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Which order or page should it have used? (optional)"
          />
          <div className="feedback-panel-actions">
            <button type="button" className="feedback-cancel" onClick={() => setPanelOpen(false)}>
              Close
            </button>
            <button
              type="button"
              className="feedback-submit"
              onClick={() => {
                onFeedback("down", reason, comment.trim() || null);
                setPanelOpen(false);
                setThanks(true);
                window.setTimeout(() => setThanks(false), 2500);
              }}
            >
              Send feedback
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TurnView({
  turn,
  onOpenSource,
  onRetry,
  actions,
  suggestions,
}: {
  turn: ChatTurn;
  onOpenSource: (source: Source) => void;
  onRetry?: () => void;
  actions?: ReactNode;
  /** Follow-up questions under the latest answer (ADR-065). */
  suggestions?: ReactNode;
}) {
  const askedAt = formatTurnTime(turn.askedAt ?? turn.id);

  return (
    <article className="turn">
      <div className="question-bubble">
        {turn.question}
      </div>
      <time className="turn-time" dateTime={askedAt.iso} title={askedAt.full}>
        {askedAt.short}
      </time>

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
          <div
            className={turn.stopped ? "error-box error-box-with-action stopped-box" : "error-box error-box-with-action"}
            role={turn.stopped ? "status" : "alert"}
          >
            <span>{turn.error}</span>
            {onRetry ? (
              <button
                type="button"
                className="retry-button"
                onClick={onRetry}
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : (
          <div className="answer-text">
            {turn.answer ? (
              <FormattedAnswer
                text={turn.answer}
                sources={turn.sources}
                onOpenSource={onOpenSource}
              />
            ) : turn.done ? null : (
              <>
                <ProgressIndicator
                  label={turn.status}
                  startedAt={turn.id}
                />
                {turn.draft ? <DraftPreview text={turn.draft} /> : null}
              </>
            )}
          </div>
        )}

        {actions}

        {turn.done ? (
          <div className="answer-status">
            {/* A safe fallback is a fixed message, so "Validated" would mislead. */}
            {turn.done.noEvidence || turn.done.usedFallback ? null : turn.done.listing ? (
              <span
                className="badge badge-safe"
                title="Listed from the recorded order dates, numbers, sections and subjects; no text was generated."
              >
                {turn.done.find ? "Order search" : "Order list"}
              </span>
            ) : <span
              className={
                turn.done
                  .conversational
                  ? "badge"
                  : turn.done
                      .validated
                    ? "badge badge-safe"
                    : "badge badge-warning"
              }
            >
              {turn.done
                .conversational
                ? "Conversation"
                : turn.done
                    .validated
                  ? "Validated"
                  : "Not validated"}
            </span>}

            {turn.done.noEvidence ? (
              <span className="badge badge-warning">No matching order</span>
            ) : null}

            {turn.done.shortened ? (
              <span
                className="badge badge-warning"
                title="The answer reached the length limit and was cut back to its last complete sentence. Ask a follow-up (e.g. 'बाकी शर्तें बताएं') for the rest."
              >
                Shortened
              </span>
            ) : null}

            {turn.done.scopeFallback ? (
              <span className="badge" title="Nothing close was found in your profile departments, so every department was searched.">
                Searched all departments
              </span>
            ) : null}

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

        {turn.done ? <SafetyCheckDetails done={turn.done} /> : null}

        {turn.done?.timings ? (
          <details className="timing-details">
            <summary>
              Latency breakdown
              {typeof turn.done.timings.totalMs ===
              "number"
                ? ` - ${(turn.done.timings.totalMs / 1000).toFixed(1)} s`
                : ""}
            </summary>

            <div className="timing-grid">
              <span>Retrieval</span>
              <strong>{formatStageMs(turn.done.timings.retrievalMs)}</strong>
              <span>Embedding</span>
              <strong>{formatStageMs(turn.done.timings.embeddingMs)}</strong>
              <span>Hybrid search</span>
              <strong>{formatStageMs(turn.done.timings.hybridSearchMs)}</strong>
              <span>Rerank</span>
              <strong>{formatStageMs(turn.done.timings.rerankMs)}</strong>
              <span>Hydration</span>
              <strong>{formatStageMs(turn.done.timings.hydrationMs)}</strong>
              <span>Generation</span>
              <strong>{formatStageMs(turn.done.timings.generationMs)}</strong>
              <span>Repair</span>
              <strong>{formatStageMs(turn.done.timings.repairMs)}</strong>
              <span>Validation</span>
              <strong>{formatStageMs(turn.done.timings.validationMs)}</strong>
              {typeof turn.done.bestRelevance === "number" ? (
                <>
                  <span title="Reranker relevance of the best matching page (0–1). Pages below RAG_MIN_RELEVANCE are not used.">Best match</span>
                  <strong>{turn.done.bestRelevance.toFixed(2)}</strong>
                </>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>

      {turn.sources.length > 0 && !turn.done?.noEvidence ? (
        <SourcesSection turn={turn} onOpenSource={onOpenSource} />
      ) : null}

      {suggestions}
    </article>
  );
}

// Follow-up questions (ADR-065): asked once per answer, after it is shown.
const suggestionCache = new Map<number, string[]>();

function wantsSuggestions(turn: ChatTurn): boolean {
  const done = turn.done;
  return Boolean(
    done && turn.answer && !turn.error && !done.noEvidence && !done.usedFallback && !done.conversational,
  );
}

function SuggestedQuestions({
  turn,
  disabled,
  onAsk,
}: {
  turn: ChatTurn;
  disabled: boolean;
  onAsk: (question: string) => void;
}) {
  const language = speechLanguageFor(turn.answer) === "hi-IN" || speechLanguageFor(turn.question) === "hi-IN" ? "hi" : "en";
  const [items, setItems] = useState<string[] | null>(suggestionCache.get(turn.id) ?? null);

  useEffect(() => {
    if (suggestionCache.has(turn.id)) return;
    const controller = new AbortController();
    const cited = turn.done?.listing
      ? turn.sources
      : turn.sources.filter((source) => (turn.done?.citations ?? []).some((c) => /S\d+/.exec(c)?.[0] === source.label));
    const sources = (cited.length ? cited : turn.sources).slice(0, 6).map((source) => ({
      title: source.documentTitle ?? null,
      goNumber: source.goNumber,
      goDate: source.goDate,
      department: source.department,
    }));

    fetch("/api/rag/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: turn.question,
        answer: turn.answer.slice(0, 12000),
        language,
        listing: Boolean(turn.done?.listing),
        sources,
      }),
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { suggestions?: unknown } | null) => {
        const list = Array.isArray(data?.suggestions)
          ? data.suggestions.filter((item): item is string => typeof item === "string").slice(0, 3)
          : [];
        suggestionCache.set(turn.id, list);
        setItems(list);
      })
      .catch(() => {
        /* aborted or offline: show nothing */
      });

    return () => controller.abort();
  }, [turn.id, turn.question, turn.answer, turn.sources, turn.done, language]);

  if (!items) {
    return (
      <div className="suggestions suggestions-loading" aria-hidden="true">
        <span className="suggestions-title">{language === "hi" ? "संबंधित प्रश्न" : "Related questions"}</span>
        <span className="suggestion-chip suggestion-skeleton" />
        <span className="suggestion-chip suggestion-skeleton" />
      </div>
    );
  }
  if (!items.length) return null;

  return (
    <div className="suggestions" role="group" aria-label={language === "hi" ? "संबंधित प्रश्न" : "Related questions"}>
      <span className="suggestions-title">{language === "hi" ? "संबंधित प्रश्न" : "Related questions"}</span>
      {items.map((item) => (
        <button
          key={item}
          type="button"
          className="suggestion-chip"
          disabled={disabled}
          onClick={() => onAsk(item)}
        >
          <span aria-hidden="true">↳</span> {item}
        </button>
      ))}
    </div>
  );
}

/**
 * Sources under an answer. Once the answer is complete, only orders it cites
 * are shown; other retrieved orders stay behind a toggle so unrelated PDFs do
 * not look like support for the answer.
 */
function SourcesSection({
  turn,
  onOpenSource,
}: {
  turn: ChatTurn;
  onOpenSource: (source: Source) => void;
}) {
  const [showOthers, setShowOthers] = useState(false);
  const groups = groupSources(turn.sources, turn.answer);
  const complete = Boolean(turn.done);
  const cited = groups.filter((group) => group.anyCited);
  // While streaming, or when nothing is cited (e.g. a salvage answer), show all.
  const primary = complete && cited.length > 0 ? cited : groups;
  const others = complete && cited.length > 0 ? groups.filter((group) => !group.anyCited) : [];
  const language = speechLanguageFor(turn.answer) === "hi-IN" ? "hi" : "en";

  const card = (group: SourceGroup) => (
    <SourceGroupCard
      key={group.sourceId}
      group={group}
      language={language}
      onOpenSource={onOpenSource}
    />
  );

  return (
    <div className="sources-section">
      <div className="section-label">Sources</div>
      <div className="source-groups">{primary.map(card)}</div>
      {others.length > 0 ? (
        <>
          <button
            type="button"
            className="sources-others-toggle"
            aria-expanded={showOthers}
            onClick={() => setShowOthers((value) => !value)}
          >
            {showOthers
              ? "Hide other retrieved orders"
              : `${others.length} other retrieved order${others.length === 1 ? "" : "s"} (not cited)`}
          </button>
          {showOthers ? <div className="source-groups source-groups-others">{others.map(card)}</div> : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * The model's first draft, streamed while it writes. It has not passed the
 * citation and number checks yet, so it is muted, labelled and replaced by the
 * checked answer (which may differ).
 */
function DraftPreview({ text }: { text: string }) {
  const hindi = speechLanguageFor(text) === "hi-IN";
  return (
    <div className="answer-draft" aria-live="off">
      <div className="answer-draft-label">
        {hindi
          ? "मसौदा — उद्धरण और संख्याओं की जाँच हो रही है"
          : "Draft — being checked against the cited pages"}
      </div>
      <div className="answer-draft-text">{text.replace(/NO_ANSWER_IN_EVIDENCE/g, "").trim()}</div>
    </div>
  );
}

export function ChatApp({
  workspaceUserId,
  conversationId,
  archived = false,
  onRestoreArchived,
  onHistoryChanged,
  preferredLanguage,
}: ChatAppProps = {}) {
  const [query, setQuery] =
    useState("");

  const [speechLanguage, setSpeechLanguage] = useState<"en-IN" | "hi-IN">(
    preferredLanguage === "hi" ? "hi-IN" : "en-IN",
  );
  const [speechState, setSpeechState] = useState<"idle" | "starting" | "listening" | "stopping">("idle");
  const [speechStatus, setSpeechStatus] = useState<string | null>(null);
  const speechRecognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const speechStartingQueryRef = useRef("");
  const speechInputActive = speechState !== "idle";
  const speechLanguageName = speechLanguage === "hi-IN" ? "Hindi" : "English";

  // Hindi typing (ADR-061): with HI selected, words typed in English letters
  // become Devanagari on Space; Backspace right after undoes it.
  const hindiTyping = speechLanguage === "hi-IN";
  const transliterator = useHindiTransliterator(hindiTyping);
  const lastConversionRef = useRef<Conversion | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const [caret, setCaret] = useState(0);
  const toDevanagari = (latin: string) => transliterator?.suggest(latin, 1)[0];
  const speechButtonLabel = speechState === "listening"
    ? "Stop voice input"
    : speechState === "starting"
      ? "Cancel voice input"
      : speechState === "stopping"
        ? "Finishing voice input"
        : `Start ${speechLanguageName} voice input`;
  const speechButtonClass = speechState === "idle"
    ? "speech-input-button"
    : `speech-input-button is-${speechState}`;

  const [turns, setTurns] =
    useState<ChatTurn[]>([]);

  const [
    currentConversationId,
    setCurrentConversationId,
  ] =
    useState<
      string | null
    >(
      conversationId ??
        null,
    );

  const [
    historyLoading,
    setHistoryLoading,
  ] =
    useState(
      Boolean(
        workspaceUserId &&
        conversationId,
      ),
    );

  const [busy, setBusy] =
    useState(false);
  // The request in flight, so Stop (or Esc) can cancel it.
  const inFlightRef = useRef<AbortController | null>(null);
  const stopAnswer = () => inFlightRef.current?.abort();

  // Put the caret back where an automatic edit (conversion, undo) left it.
  useLayoutEffect(() => {
    const position = pendingCaretRef.current;
    const input = composerInputRef.current;
    if (position === null || !input) return;
    pendingCaretRef.current = null;
    input.setSelectionRange(position, position);
  }, [query]);

  // Examples and guide entries fill the input (to edit before sending).
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const pickExample = (text: string) => {
    setQuery(text);
    setGuideOpen(false);
    window.requestAnimationFrame(() => {
      const input = composerInputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(text.length, text.length);
    });
  };

  // The guide popover closes on Esc or a click outside it.
  useEffect(() => {
    if (!guideOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setGuideOpen(false);
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest(".search-guide-popover, .composer-guide-button")) setGuideOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [guideOpen]);

  // Esc stops the answer too, unless a dialog (e.g. the search guide) is open.
  useEffect(() => {
    if (!busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], dialog[open]')) return;
      inFlightRef.current?.abort();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

  const conversationEndRef = useRef<HTMLDivElement | null>(null);

  const [copiedTurnId, setCopiedTurnId] = useState<number | null>(null);
  const [speakingTurnId, setSpeakingTurnId] = useState<number | null>(null);
  const [speechOutputSupported, setSpeechOutputSupported] = useState(false);

  useEffect(() => {
    setSpeechOutputSupported(
      typeof window !== "undefined" && "speechSynthesis" in window,
    );
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const copyAnswer = async (turn: ChatTurn) => {
    try {
      await copyToClipboard(answerCopyText(turn));
      setCopiedTurnId(turn.id);
      window.setTimeout(
        () => setCopiedTurnId((current) => (current === turn.id ? null : current)),
        2000,
      );
    } catch (error) {
      console.warn("Could not copy the answer.", error);
    }
  };

  const toggleListen = (turn: ChatTurn) => {
    const synth = window.speechSynthesis;
    if (speakingTurnId === turn.id) {
      synth.cancel();
      setSpeakingTurnId(null);
      return;
    }

    synth.cancel();
    const text = answerSpeechText(turn.answer);
    const utterance = new SpeechSynthesisUtterance(text);
    const lang = speechLanguageFor(text);
    utterance.lang = lang;
    const voice =
      synth.getVoices().find((item) => item.lang === lang) ??
      synth.getVoices().find((item) => item.lang.startsWith(lang.slice(0, 2)));
    if (voice) utterance.voice = voice;
    utterance.onend = () => setSpeakingTurnId((current) => (current === turn.id ? null : current));
    utterance.onerror = () => setSpeakingTurnId((current) => (current === turn.id ? null : current));
    setSpeakingTurnId(turn.id);
    synth.speak(utterance);
  };

  const sendFeedback = async (
    turn: ChatTurn,
    rating: FeedbackRating | null,
    reason: string | null = null,
    comment: string | null = null,
  ) => {
    const previous = turn.feedback ?? null;
    const next: TurnFeedback | null = rating ? { rating, reason, comment } : null;
    setTurns((current) =>
      current.map((item) => (item.id === turn.id ? { ...item, feedback: next } : item)),
    );

    // Votes are stored with the saved answer; unsaved turns keep them locally.
    if (!workspaceUserId || !currentConversationId || !turn.assistantMessageId) {
      return;
    }

    try {
      await workspaceJson(
        `/api/workspace/users/${encodeURIComponent(workspaceUserId)}/conversations/${encodeURIComponent(currentConversationId)}/messages/${encodeURIComponent(turn.assistantMessageId)}/feedback`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rating, reason, comment }),
        },
      );
    } catch (error) {
      console.warn("Could not save feedback.", error);
      setTurns((current) =>
        current.map((item) => (item.id === turn.id ? { ...item, feedback: previous } : item)),
      );
    }
  };

  // When a question is asked (or a saved chat opens), bring the newest
  // question to the top of the view so its answer appears below it, above
  // the pinned composer.
  useEffect(() => {
    if (turns.length === 0) return;
    const turnsInView =
      conversationEndRef.current?.parentElement?.querySelectorAll(
        "article.turn",
      );
    turnsInView?.[turnsInView.length - 1]?.scrollIntoView({
      block: "start",
      behavior: turns.length > 1 ? "smooth" : "auto",
    });
  }, [turns.length]);


  useEffect(() => () => {
    speechRecognitionRef.current?.abort();
    speechRecognitionRef.current = null;
  }, []);

  useEffect(
    () => {
      let cancelled =
        false;

      const load =
        async () => {
          setCurrentConversationId(
            conversationId ??
              null,
          );

          if (
            !workspaceUserId ||
            !conversationId
          ) {
            setTurns([]);
            setHistoryLoading(
              false,
            );
            return;
          }

          setHistoryLoading(
            true,
          );

          try {
            const data =
              await workspaceJson<
                PersistedConversationResponse
              >(
                `/api/workspace/users/${encodeURIComponent(workspaceUserId)}/conversations/${encodeURIComponent(conversationId)}`,
              );

            if (!cancelled) {
              setTurns(
                turnsFromPersistedMessages(
                  data.messages,
                ),
              );
            }
          } catch (
            caught
          ) {
            if (!cancelled) {
              setTurns([
                {
                  id:
                    Date.now(),
                  question:
                    "Conversation history",
                  answer: "",
                  sources: [],
                  done: null,
                  error:
                    caught instanceof Error
                      ? caught.message
                      : String(
                          caught,
                        ),
                  elapsedMs:
                    null,
                },
              ]);
            }
          } finally {
            if (!cancelled) {
              setHistoryLoading(
                false,
              );
            }
          }
        };

      void load();

      return () => {
        cancelled = true;
      };
    },
    [
      conversationId,
      workspaceUserId,
    ],
  );

  // Rulebook §1: a citation opens the official government copy at the cited
  // page, never our archived file.
  const openSource =
    (source: Source) => {
      const url = officialPageUrl(source);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    };

  const toggleSpeechInput = () => {
    if (speechState !== "idle") {
      if (speechState === "stopping") return;
      setSpeechState("stopping");
      const activeRecognition = speechRecognitionRef.current;
      if (!activeRecognition) {
        setSpeechState("idle");
        return;
      }
      try {
        activeRecognition.stop();
      } catch {
        activeRecognition.abort();
        speechRecognitionRef.current = null;
        setSpeechState("idle");
        setSpeechStatus("Voice input stopped.");
      }
      return;
    }

    const speechWindow = window as SpeechRecognitionWindow;
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setSpeechStatus("Voice input is not supported by this browser. Try a browser with speech recognition support.");
      return;
    }

    const recognition = new Recognition();
    recognition.lang = speechLanguage;
    recognition.continuous = true;
    recognition.interimResults = true;
    speechStartingQueryRef.current = query;
    recognition.onstart = () => {
      setSpeechState((current) => current === "starting" ? "listening" : current);
      setSpeechStatus(null);
    };
    recognition.onresult = (event) => {
      let transcript = "";
      let lastSegmentIsFinal = true;
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const segment = result?.[0]?.transcript ?? "";
        transcript = appendSpeechTranscriptSegment(
          transcript,
          segment,
        );
        if (segment.trim()) lastSegmentIsFinal = result?.isFinal ?? true;
      }
      if (!lastSegmentIsFinal && transcript && !/[,.!?।॥…:;]$/u.test(transcript)) {
        transcript += " ";
      }
      const startingQuery = speechStartingQueryRef.current;
      let recognizedText = transcript;
      if (!startingQuery.trim() && recognizedText) {
        recognizedText = recognizedText[0].toLocaleUpperCase() + recognizedText.slice(1);
      }
      const separator = startingQuery && recognizedText && !/\s$/.test(startingQuery) ? " " : "";
      setQuery(`${startingQuery}${separator}${recognizedText}`);
    };
    recognition.onerror = (event) => {
      const message = event.error === "not-allowed" || event.error === "service-not-allowed"
        ? "Allow microphone access to use voice input."
        : event.error === "no-speech"
          ? "No speech was detected. Try again."
          : event.error === "audio-capture"
            ? "No microphone is available."
            : "Speech recognition could not connect. Check your connection and try again.";
      setSpeechStatus(message);
      speechRecognitionRef.current = null;
      setSpeechState("idle");
    };
    recognition.onend = () => {
      if (speechRecognitionRef.current === recognition) {
        speechRecognitionRef.current = null;
        setSpeechState("idle");
      }
    };
    speechRecognitionRef.current = recognition;
    setSpeechStatus(null);
    setSpeechState("starting");
    try {
      recognition.start();
    } catch {
      speechRecognitionRef.current = null;
      setSpeechState("idle");
      setSpeechStatus("Could not start voice input. Check microphone access and try again.");
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (speechInputActive) {
      toggleSpeechInput();
      return;
    }

    // Hindi typing: the last word has no Space after it yet.
    const question = (hindiTyping && transliterator ? convertTrailingWord(query, toDevanagari) : query).trim();

    if (!question || busy || archived) {
      return;
    }

    setQuery("");
    void ask(question, turns);
  };

  // Retry replaces the failed turn in place and asks the same question again.
  const retry = (failed: ChatTurn) => {
    if (busy || archived) {
      return;
    }

    const remaining = turns.filter((turn) => turn.id !== failed.id);
    setTurns(remaining);
    void ask(failed.question, remaining);
  };

  // Regenerate the latest answer: same question, fresh draft, same safety gate.
  // The saved answer is replaced in place (its previous version is kept).
  const regenerate = (target: ChatTurn) => {
    if (busy || archived) {
      return;
    }

    if (speakingTurnId === target.id) {
      window.speechSynthesis.cancel();
      setSpeakingTurnId(null);
    }

    const remaining = turns.filter((turn) => turn.id !== target.id);
    setTurns(remaining);
    void ask(target.question, remaining, { regenerateOf: target });
  };

  const ask =
    async (
      question: string,
      priorTurns: ChatTurn[],
      options: { regenerateOf?: ChatTurn } = {},
    ) => {
      setBusy(true);
      const controller = new AbortController();
      inFlightRef.current = controller;

      const id =
        Date.now();

      const started =
        performance.now();

      const newTurn: ChatTurn = {
        id,
        askedAt:
          options.regenerateOf?.askedAt ?? Date.now(),
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

      let effectiveConversationId =
        currentConversationId;

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

      const conversationMessages = [
        ...priorTurns
          .filter(
            (turn) =>
              Boolean(
                turn.answer.trim(),
              ) &&
              !turn.error,
          )
          .slice(-4)
          .map(
            (turn) => ({
              role:
                "user" as const,
              content:
                turn.question,
            }),
          ),
        {
          role:
            "user" as const,
          content:
            question,
        },
      ];

      const conversationState =
        deriveConversationState(
          priorTurns,
        );

      let persistedAnswer =
        "";
      let persistedSources:
        Source[] = [];
      let persistedDone:
        DoneEvent | null =
        null;

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
                messages:
                  conversationMessages,
                conversationState,
                workspaceUserId,
                regenerate:
                  Boolean(options.regenerateOf),
              }),
              signal: controller.signal,
            },
          );

        if (!response.ok) {
          throw new Error(
            await describeHttpFailure(response),
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
              parsed.event === "status" &&
              parsed.data &&
              typeof parsed.data === "object"
            ) {
              const label = (parsed.data as { label?: unknown }).label;
              if (typeof label === "string") {
                update((turn) => ({ ...turn, status: label }));
              }
              return;
            }

            if (
              parsed.event === "draft" &&
              parsed.data &&
              typeof parsed.data === "object"
            ) {
              const text = (parsed.data as { text?: unknown }).text;
              if (typeof text === "string") {
                update((turn) => ({ ...turn, draft: (turn.draft ?? "") + text }));
              }
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

              persistedSources =
                parsed.data as
                  Source[];

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

                persistedAnswer +=
                  text;
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

              persistedDone =
                parsed.data as
                  DoneEvent;

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
                    describeServiceError(message),
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
        if (
          workspaceUserId &&
          persistedAnswer.trim()
        ) {
          try {
            const replaceId =
              options.regenerateOf?.assistantMessageId ?? null;

            if (replaceId && effectiveConversationId) {
              // Regenerated answer replaces the saved one in place.
              await workspaceJson(
                `/api/workspace/users/${encodeURIComponent(workspaceUserId)}/conversations/${encodeURIComponent(effectiveConversationId)}/messages/${encodeURIComponent(replaceId)}`,
                {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    content: persistedAnswer,
                    sources: persistedSources,
                    metadata: { ...(persistedDone ?? {}), regenerated: true },
                  }),
                },
              );
              update((turn) => ({ ...turn, assistantMessageId: replaceId, feedback: null }));
            } else {
            // Persist only completed turns, so a failed attempt does not
            // leave a question-only conversation behind in history.
            if (!effectiveConversationId) {
              const created =
                await workspaceJson<{ id: string }>(
                  `/api/workspace/users/${encodeURIComponent(workspaceUserId)}/conversations`,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ firstQuestion: question }),
                  },
                );

              effectiveConversationId = created.id;
              setCurrentConversationId(created.id);
            }

            await workspaceJson(
              `/api/workspace/users/${encodeURIComponent(workspaceUserId)}/conversations/${encodeURIComponent(effectiveConversationId)}/messages`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ role: "user", content: question }),
              },
            );

            const savedAnswer = await workspaceJson<{ id: string }>(
              `/api/workspace/users/${encodeURIComponent(workspaceUserId)}/conversations/${encodeURIComponent(effectiveConversationId)}/messages`,
              {
                method:
                  "POST",
                headers: {
                  "content-type":
                    "application/json",
                },
                body:
                  JSON.stringify({
                    role:
                      "assistant",
                    content:
                      persistedAnswer,
                    sources:
                      persistedSources,
                    metadata:
                      persistedDone ??
                      {},
                  }),
              },
            );
            update((turn) => ({ ...turn, assistantMessageId: savedAnswer.id }));

            }

            if (
              !(persistedDone as DoneEvent | null)
                ?.conversational
            ) {
              const state =
                dominantSourceState(
                  persistedSources,
                );

              await workspaceJson(
                `/api/workspace/users/${encodeURIComponent(workspaceUserId)}/conversations/${encodeURIComponent(effectiveConversationId)}/state`,
                {
                  method:
                    "PUT",
                  headers: {
                    "content-type":
                      "application/json",
                  },
                  body:
                    JSON.stringify({
                      ...state,
                      topicSummary:
                        question,
                    }),
                },
              );
            }

            onHistoryChanged?.();
          } catch (
            persistenceError
          ) {
            console.warn(
              "Could not persist assistant answer.",
              persistenceError,
            );
          }
        }

      } catch (error) {
        if (controller.signal.aborted) {
          // Stopped: nothing is saved; the question goes back into the box
          // (unless something new was typed) so it can be edited and re-sent.
          update((turn) => ({
            ...turn,
            stopped: true,
            status: null,
            draft: undefined,
            error: "Stopped. The answer was not finished.",
            elapsedMs: performance.now() - started,
          }));
          setQuery((current) => (current.trim() ? current : question));
        } else {
          update(
            (turn) => ({
              ...turn,
              error:
                describeFetchFailure(error),
              elapsedMs:
                performance.now() -
                started,
            }),
          );
        }
      } finally {
        if (inFlightRef.current === controller) inFlightRef.current = null;
        setBusy(false);
      }
    };

  if (historyLoading) {
    return (
      <main className="shell">
        <div className="muted">
          Loading conversation…
        </div>
      </main>
    );
  }

  return (
    <main className={turns.length > 0 ? "shell shell-active" : "shell"}>
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

      <section className="conversation">
        {turns.length === 0 ? (
          <StartPanel onPick={pickExample} />
        ) : (
          turns.map(
            (turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                onOpenSource={openSource}
                onRetry={
                  turn.error && !busy && !archived
                    ? () => retry(turn)
                    : undefined
                }
                actions={
                  turn.done && turn.answer && !turn.error ? (
                    <AnswerActions
                      turn={turn}
                      copied={copiedTurnId === turn.id}
                      speaking={speakingTurnId === turn.id}
                      speechSupported={speechOutputSupported}
                      canRegenerate={
                        !busy &&
                        !archived &&
                        turn.id === turns[turns.length - 1]?.id
                      }
                      onCopy={() => void copyAnswer(turn)}
                      onListen={() => toggleListen(turn)}
                      onFeedback={(rating, reason, comment) =>
                        void sendFeedback(turn, rating, reason ?? null, comment ?? null)
                      }
                      onRegenerate={() => regenerate(turn)}
                    />
                  ) : null
                }
                suggestions={
                  !archived && turn.id === turns[turns.length - 1]?.id && wantsSuggestions(turn) ? (
                    <SuggestedQuestions
                      turn={turn}
                      disabled={busy}
                      onAsk={(question) => {
                        if (busy || archived) return;
                        setQuery("");
                        void ask(question, turns);
                      }}
                    />
                  ) : null
                }
              />
            ),
          )
        )}
        <div ref={conversationEndRef} aria-hidden="true" />
      </section>

      {/* Composer stays pinned to the bottom of the window, ChatGPT-style. */}
      <div className="composer-dock">
      {archived ? (
        <div className="archived-banner" role="status">
          <span>
            This conversation is archived. Restore it to continue asking
            questions.
          </span>
          {onRestoreArchived ? (
            <button type="button" onClick={onRestoreArchived}>
              Restore
            </button>
          ) : null}
        </div>
      ) : null}

      <form
        className="composer"
        onSubmit={submit}
      >
        <textarea
          value={query}
          onChange={(event) => {
            const value = event.target.value;
            const position = event.target.selectionStart ?? value.length;
            if (hindiTyping && transliterator && !(event.nativeEvent as InputEvent).isComposing) {
              const converted = convertFinishedWord(query, value, position, toDevanagari);
              if (converted) {
                lastConversionRef.current = converted.conversion;
                pendingCaretRef.current = converted.caret;
                setCaret(converted.caret);
                setQuery(converted.value);
                return;
              }
            }
            lastConversionRef.current = null;
            setCaret(position);
            setQuery(value);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          ref={composerInputRef}
          lang={hindiTyping ? "hi" : undefined}
          placeholder={
            hindiTyping
              ? "हिंदी में लिखें: English letters में टाइप करें (kya, yojana…), Space दबाने पर देवनागरी बनेगी"
              : "Ask a question, or find an order by number, subject, department or date…"
          }
          aria-label="Ask a question or find an order"
          rows={3}
          aria-keyshortcuts="Enter"
          disabled={busy || archived}
          onKeyDown={(
            event,
          ) => {
            // Backspace right after a conversion brings the English letters back.
            if (
              event.key === "Backspace" &&
              hindiTyping &&
              event.currentTarget.selectionStart === event.currentTarget.selectionEnd
            ) {
              const undone = undoConversion(query, event.currentTarget.selectionStart ?? 0, lastConversionRef.current);
              if (undone) {
                event.preventDefault();
                lastConversionRef.current = null;
                pendingCaretRef.current = undone.caret;
                setCaret(undone.caret);
                setQuery(undone.value);
                return;
              }
            }
            if (
              event.key ===
                "Enter" &&
              !event.shiftKey
            ) {
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (!speechInputActive && query.trim()) {
                event.currentTarget
                  .form
                  ?.requestSubmit();
              }
            }
          }}
        />

        {guideOpen ? (
          <div className="search-guide-popover" role="dialog" aria-label="Search guide">
            <SearchGuide onPick={pickExample} compact />
          </div>
        ) : null}

        <div className="composer-actions">
          <button
            type="button"
            className="composer-guide-button"
            aria-label="Search guide"
            aria-expanded={guideOpen}
            title="Search guide: phrases, wildcards, GO numbers, dates"
            onClick={() => setGuideOpen((open) => !open)}
          >
            ?
          </button>
          <div className="speech-language-toggle" role="group" aria-label="Input language (voice and typing)">
            <button
              type="button"
              className={speechLanguage === "en-IN" ? "active" : ""}
              aria-pressed={speechLanguage === "en-IN"}
              aria-label="English input"
              title="English: voice input and typing as typed"
              disabled={busy || speechInputActive}
              onClick={() => setSpeechLanguage("en-IN")}
            >
              EN
            </button>
            <button
              type="button"
              className={speechLanguage === "hi-IN" ? "active" : ""}
              aria-pressed={speechLanguage === "hi-IN"}
              aria-label="Hindi input in Devanagari"
              title="Hindi: voice input, and typing in English letters becomes Devanagari (kya → क्या)"
              disabled={busy || speechInputActive}
              onClick={() => setSpeechLanguage("hi-IN")}
            >
              HI
            </button>
          </div>
          <button
            type="button"
            className={speechButtonClass}
            aria-label={speechButtonLabel}
            aria-pressed={speechInputActive}
            title={speechButtonLabel}
            disabled={busy || speechState === "stopping"}
            onClick={toggleSpeechInput}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {speechState === "listening" ? (
                <rect className="speech-stop-icon" x="7" y="7" width="10" height="10" rx="2" />
              ) : speechState === "starting" || speechState === "stopping" ? (
                <circle className="speech-progress-icon" cx="12" cy="12" r="8" />
              ) : (
                <>
                  <rect x="9" y="3" width="6" height="12" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8" />
                </>
              )}
            </svg>
          </button>
          {busy ? (
            <button
              type="button"
              className="composer-submit-button composer-stop-button"
              aria-label="Stop answer"
              title="Stop (Esc)"
              onClick={stopAnswer}
            >
              <span className="send-progress-spinner" aria-hidden="true" />
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="8" y="8" width="8" height="8" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              type="submit"
              className="composer-submit-button"
              aria-label="Send message"
              title="Send message"
              disabled={
                speechInputActive ||
                !query.trim()
              }
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 19V5m-7 7 7-7 7 7" />
              </svg>
            </button>
          )}
        </div>

        {hindiTyping && !speechInputActive ? (
          <HindiTypingBar
            query={query}
            caret={caret}
            transliterator={transliterator}
            onChoose={(start, end, text) => {
              const next = `${query.slice(0, start)}${text} ${query.slice(end).replace(/^ /, "")}`;
              lastConversionRef.current = null;
              pendingCaretRef.current = start + text.length + 1;
              setCaret(start + text.length + 1);
              setQuery(next);
              composerInputRef.current?.focus();
            }}
          />
        ) : null}

        {speechStatus || speechInputActive ? (
          <div className="speech-status" role="status" aria-live="polite">
            {speechStatus ?? (speechState === "starting"
              ? "Connecting to microphone…"
              : speechState === "stopping"
                ? "Finishing voice input…"
                : `Listening in ${speechLanguageName}…`)}
          </div>
        ) : null}
      </form>

      <footer className="footer-note">
        Critical dates, amounts,
        percentages, rule numbers,
        levels and identifiers may
        require verification against
        the original PDF page when
        OCR evidence is uncertain.
      </footer>
      </div>

    </main>
  );
}
