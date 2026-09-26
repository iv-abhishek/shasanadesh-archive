"use client";

import {
  FormEvent,
  Fragment,
  useEffect,
  useMemo,
  useRef,
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
  documentTitle?: string | null;
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
  matchedChunkText?: string;  retrievalRole?:
    | "direct"
    | "neighbor";
  anchorPageNumber?:
    number | null;

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
  retrievalScope?: string;  timings?: RagTimings;

}

interface ChatTurn {
  id: number;
  question: string;
  answer: string;
  sources: Source[];
  done: DoneEvent | null;
  error: string | null;
  elapsedMs: number | null;
  status?: string | null;
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
}

interface PersistedConversationResponse {
  messages:
    PersistedMessage[];
}

interface ViewerState {
  source: Source;
}

function pdfProxyUrl(source: Source): string {
  return (
    `/api/rag/pdf?sourceId=${encodeURIComponent(source.sourceId)}` +
    `#page=${source.pageNumber}&zoom=page-width`
  );
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
  pages: Array<Source & { cited: boolean }>;
  anyCited: boolean;
}

function groupSources(sources: Source[], answer: string): SourceGroup[] {
  const cited = citedKeys(answer);
  const groups = new Map<string, SourceGroup>();

  for (const source of sources) {
    let group = groups.get(source.sourceId);

    if (!group) {
      const subtitle = [
        source.documentTitle && source.department ? source.department : null,
        source.goNumber ? `GO ${source.goNumber}` : null,
        source.goDate,
      ].filter((value): value is string => Boolean(value));

      group = {
        sourceId: source.sourceId,
        title:
          source.documentTitle ||
          source.department ||
          "Government order",
        subtitle,
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
  onOpenSource,
}: {
  group: SourceGroup;
  onOpenSource: (source: Source) => void;
}) {
  const [showNearby, setShowNearby] = useState(false);
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
        title={`${page.label} · ${role} · ${statusLabel(page.numericVerificationStatus)} — open page ${page.pageNumber}`}
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
        <span className={summary.className}>{summary.label}</span>
      </div>

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

      <div className="source-id">{group.sourceId}</div>
    </section>
  );
}

function TurnView({
  turn,
  onOpenSource,
  onRetry,
}: {
  turn: ChatTurn;
  onOpenSource: (source: Source) => void;
  onRetry?: () => void;
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
          <div className="error-box error-box-with-action" role="alert">
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
              <ProgressIndicator
                label={turn.status}
                startedAt={turn.id}
              />
            )}
          </div>
        )}

        {turn.done ? (
          <div className="answer-status">
            <span
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
            </div>
          </details>
        ) : null}
      </div>

      {turn.sources.length >
      0 ? (
        <div className="sources-section">
          <div className="section-label">
            Sources
          </div>

          <div className="source-groups">
            {groupSources(turn.sources, turn.answer).map((group) => (
              <SourceGroupCard
                key={group.sourceId}
                group={group}
                onOpenSource={onOpenSource}
              />
            ))}
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

  const conversationEndRef = useRef<HTMLDivElement | null>(null);

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

  const [viewer, setViewer] =
    useState<ViewerState | null>(null);

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

  const openSource =
    (source: Source) => {
      setViewer({ source });
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

    const question = query.trim();

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

  const ask =
    async (
      question: string,
      priorTurns: ChatTurn[],
    ) => {
      setBusy(true);

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
              }),
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

            await workspaceJson(
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
      } finally {
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

      {turns.length === 0 ? (
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
      ) : null}

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
                onRetry={
                  turn.error && !busy && !archived
                    ? () => retry(turn)
                    : undefined
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
          onChange={(event) =>
            setQuery(
              event.target.value,
            )
          }
          placeholder="Ask in English or Hindi… Press Enter to send"
          rows={3}
          aria-keyshortcuts="Enter"
          disabled={busy || archived}
          onKeyDown={(
            event,
          ) => {
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

        <div className="composer-actions">
          <div className="speech-language-toggle" role="group" aria-label="Voice input language">
            <button
              type="button"
              className={speechLanguage === "en-IN" ? "active" : ""}
              aria-pressed={speechLanguage === "en-IN"}
              aria-label="Use English voice input"
              title="English voice input"
              disabled={busy || speechInputActive}
              onClick={() => setSpeechLanguage("en-IN")}
            >
              EN
            </button>
            <button
              type="button"
              className={speechLanguage === "hi-IN" ? "active" : ""}
              aria-pressed={speechLanguage === "hi-IN"}
              aria-label="Use Hindi voice input with Devanagari text"
              title="Hindi voice input; text appears in Devanagari"
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
          <button
            type="submit"
            className="composer-submit-button"
            aria-label={busy ? "Sending message" : "Send message"}
            title={busy ? "Sending message" : "Send message"}
            disabled={
              busy ||
              speechInputActive ||
              !query.trim()
            }
          >
            {busy ? (
              <span className="send-progress-spinner" aria-hidden="true" />
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 19V5m-7 7 7-7 7 7" />
              </svg>
            )}
          </button>
        </div>

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

      {viewer ? (
        <SourceViewer
          source={viewer.source}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </main>
  );
}
