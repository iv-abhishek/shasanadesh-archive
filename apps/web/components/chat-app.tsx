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
}

interface ChatAppProps {
  workspaceUserId?: string;
  conversationId?: string | null;
  onNewChat?: () => void;
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
    `/api/rag/pdf?url=${encodeURIComponent(source.sourceUrl)}` +
    `#page=${source.pageNumber}&zoom=page-width`
  );
}

const CHAT_API_PATH =
  "/api/rag/chat";

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

      <div className="source-provenance">
        <span
          className={
            source.retrievalRole ===
            "neighbor"
              ? "provenance-badge provenance-neighbor"
              : "provenance-badge"
          }
        >
          {source.retrievalRole ===
          "neighbor"
            ? source.anchorPageNumber
              ? `Neighbor of p.${source.anchorPageNumber}`
              : "Neighbor page"
            : "Direct hit"}
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

export function ChatApp({
  workspaceUserId,
  conversationId,
  onNewChat,
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

  const submit =
    async (
      event: FormEvent,
    ) => {
      event.preventDefault();

      if (speechInputActive) {
        toggleSpeechInput();
        return;
      }

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

      let effectiveConversationId =
        currentConversationId;

      if (
        workspaceUserId
      ) {
        try {
          if (
            !effectiveConversationId
          ) {
            const created =
              await workspaceJson<{
                id: string;
              }>(
                `/api/workspace/users/${encodeURIComponent(workspaceUserId)}/conversations`,
                {
                  method:
                    "POST",
                  headers: {
                    "content-type":
                      "application/json",
                  },
                  body:
                    JSON.stringify({
                      firstQuestion:
                        question,
                    }),
                },
              );

            effectiveConversationId =
              created.id;

            setCurrentConversationId(
              created.id,
            );
          }

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
                    "user",
                  content:
                    question,
                }),
            },
          );
        } catch (
          persistenceError
        ) {
          console.warn(
            "Could not persist user message.",
            persistenceError,
          );
        }
      }

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
        ...turns
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
          turns,
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
        if (
          workspaceUserId &&
          effectiveConversationId &&
          persistedAnswer.trim()
        ) {
          try {
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
          placeholder="Ask in English or Hindi… Press Enter to send"
          rows={3}
          aria-keyshortcuts="Enter"
          disabled={busy}
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
          {onNewChat ? (
            <button
              type="button"
              className="composer-new-chat-button"
              aria-label="New chat"
              title="New chat"
              disabled={busy || speechInputActive}
              onClick={onNewChat}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          ) : null}
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

      {viewer ? (
        <SourceViewer
          source={viewer.source}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </main>
  );
}
