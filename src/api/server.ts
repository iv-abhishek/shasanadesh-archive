/**
 * Shasanadesh RAG API.
 *
 * Node/TypeScript owns orchestration, evidence safety classification,
 * generator calls, deterministic answer validation, and streaming.
 *
 * Python owns local embedding/reranking.
 * Generation uses any OpenAI-compatible endpoint.
 *
 * Important safety invariant:
 *   No generated answer token is released to the client until the complete answer
 *   passes citation and numeric-safety validation (or a conservative fallback is used).
 *
 * This file avoids top-level await because the current project compiles as CommonJS.
 */

import cors from "@fastify/cors";
import { registerDocumentRoutes } from "../documents/routes.js";
import Fastify from "fastify";
import OpenAI from "openai";
import { z } from "zod";
import {
  registerWorkspaceRoutes,
} from "../workspace/routes.js";
import {
  registerSessionRoutes,
} from "../workspace/session-routes.js";
import {
  resolveSessionFromCookie,
} from "../workspace/session-store.js";
import {
  getWorkspaceProfile,
  listDepartments,
} from "../workspace/store.js";
import {
  getLocalGpuQueueStatus,
  runLocalGpuExclusive,
} from "./local-gpu-queue.js";
import {
  buildAnswerRepairInstruction,
  buildQualitativeSalvage,
  buildConservativeFallback,
  validateAnswer,
} from "../rag/answer-validation.js";
import {
  buildEvidenceContext,
  RAG_SYSTEM_PROMPT,
} from "../rag/prompt.js";
import type {
  ChatMessage,
  RetrievalResponse,
} from "../rag/types.js";
import {
  enrichRetrievalResponse,
} from "../rag/verification.js";
import {
  buildConversationQueryPlan,
  detectResponseLanguage,
} from "../rag/conversation.js";
import {
  buildConversationalReply,
  classifyConversationIntent,
  extractExplicitSourceId,
  findExplicitDepartment,
  requestsGlobalScope,
} from "../rag/intent-routing.js";
import { assessRelevance, isNoAnswer, noEvidenceMessage } from "../rag/relevance.js";
import { trimIncompleteAnswer } from "../rag/truncation.js";
import { findLaterChanges, type LaterChange } from "../rag/later-changes.js";
import { asksWhatOrderSays, detectListingRequest, jurisdictionsInQuery, listOrders, type SubjectSearch } from "../rag/order-listing.js";
import { asksAboutLaterChanges, buildLaterChangesAnswer, refersToEarlierDocument } from "../rag/document-followup.js";
import { departmentLabel, departmentNameIn, findDepartmentMention } from "../departments/registry.js";
import { createPool } from "../db/client.js";
import { officialOnly, stripNonGovernmentLinks } from "../lib/public-links.js";
import type { Pool } from "pg";
import { createDraftStreamer, stripThinking } from "../rag/draft-preview.js";
import {
  buildSuggestionMessages,
  fallbackSuggestions,
  listingSuggestions,
  parseSuggestions,
} from "../rag/suggestions.js";

const PORT = Number.parseInt(
  process.env.API_PORT ?? "8787",
  10,
);

const RETRIEVAL_BASE_URL =
  process.env.RETRIEVAL_BASE_URL ??
  "http://127.0.0.1:8788";

const LLM_BASE_URL =
  process.env.LLM_BASE_URL;

const LLM_API_KEY =
  process.env.LLM_API_KEY;

// Generation only needs to share the Apple GPU with retrieval when the model
// runs on this machine. A hosted OpenAI-compatible endpoint (e.g. DeepInfra)
// runs in parallel with local retrieval.
const LLM_IS_LOCAL = (() => {
  try {
    const host = new URL(LLM_BASE_URL ?? "http://127.0.0.1").hostname;
    return ["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(host);
  } catch {
    return true;
  }
})();

// Extra JSON merged into every chat-completion request, for provider options
// such as {"chat_template_kwargs":{"enable_thinking":false}} (hosted Qwen3
// models otherwise write a <think> block first). Invalid JSON is ignored.
const LLM_EXTRA_BODY: Record<string, unknown> = (() => {
  try {
    const raw = process.env.LLM_EXTRA_BODY?.trim();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    console.warn("Ignoring LLM_EXTRA_BODY: not valid JSON.");
    return {};
  }
})();

// Stream the first draft to the browser as a clearly marked, unchecked preview
// while it is written; the validated answer replaces it (RAG_STREAM_DRAFT=0 to
// turn off).
const RAG_STREAM_DRAFT =
  (process.env.RAG_STREAM_DRAFT ?? "1") !== "0";

const LLM_MODEL =
  process.env.LLM_MODEL;

const RAG_TOP_K = Number.parseInt(
  process.env.RAG_TOP_K ?? "5",
  10,
);

// Candidates scored by the cross-encoder. Reranking time grows roughly
// linearly with this; fewer candidates are faster but may lower recall.
const RAG_RERANK_COUNT = Math.min(
  100,
  Math.max(
    5,
    Number.parseInt(
      process.env.RAG_RERANK_COUNT ?? "24",
      10,
    ) || 24,
  ),
);

// Minimum reranker relevance (0–1) for a retrieved page to count as evidence.
// Below it the page is dropped; if nothing remains in the officer's departments
// the question is searched across all departments, and if still nothing, Ask
// says no order was found instead of answering from unrelated pages.
const RAG_MIN_RELEVANCE = Math.min(
  0.9,
  Math.max(0, Number.parseFloat(process.env.RAG_MIN_RELEVANCE ?? "0.1") || 0),
);

const RAG_NEIGHBOR_RADIUS = Number.parseInt(
  process.env.RAG_NEIGHBOR_RADIUS ?? "1",
  10,
);

const RAG_MAX_EVIDENCE_PAGES = Number.parseInt(
  process.env.RAG_MAX_EVIDENCE_PAGES ?? "7",
  10,
);

const LLM_MAX_TOKENS = Number.parseInt(
  process.env.LLM_MAX_TOKENS ?? "900",
  10,
);

// Devanagari costs several times more tokens per word than English, so Hindi
// answers get a larger budget (26 Sept: Hindi answers were cut mid-word at 900).
const LLM_MAX_TOKENS_HI = Number.parseInt(
  process.env.LLM_MAX_TOKENS_HI ?? "1800",
  10,
);

// The repair pass rewrites the whole answer, so by default it gets the same
// budget as the first draft. Set LLM_REPAIR_MAX_TOKENS to cap it (faster).
const LLM_REPAIR_MAX_TOKENS = process.env.LLM_REPAIR_MAX_TOKENS
  ? Number.parseInt(process.env.LLM_REPAIR_MAX_TOKENS, 10)
  : null;

function answerTokenBudget(language: "en" | "hi"): number {
  return language === "hi" ? LLM_MAX_TOKENS_HI : LLM_MAX_TOKENS;
}

const LLM_TEMPERATURE = Number.parseFloat(
  process.env.LLM_TEMPERATURE ?? "0.1",
);

// Regenerate uses a warmer temperature so the new draft can differ; the same
// citation and numeric safety gate still applies to it.
const REGENERATE_TEMPERATURE = Math.max(
  LLM_TEMPERATURE,
  Number.parseFloat(
    process.env.LLM_REGENERATE_TEMPERATURE ?? "0.6",
  ) || 0.6,
);

const LLM_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.LLM_REQUEST_TIMEOUT_MS ?? "1200000",
  10,
);

type GeneratorMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const server = Fastify({
  logger: true,
});

// Browsers reach this API only through the same-origin Next.js proxy, so no
// cross-origin access is needed by default. Set CORS_ORIGINS to a comma-
// separated allowlist if another trusted origin must call the API directly.
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

server.register(cors, {
  origin:
    CORS_ORIGINS.length > 0
      ? CORS_ORIGINS
      : false,
});

registerWorkspaceRoutes(server);
registerSessionRoutes(server);
registerDocumentRoutes(server);

/**
 * Orders whose subject is close in meaning to the query (ADR-058), from the
 * retrieval service. Throws when the service or its subject index is missing;
 * the finder then shows word matches only.
 */
const searchSubjects: SubjectSearch = (query, options) =>
  runLocalGpuExclusive("retrieval", async () => {
    const response = await fetch(`${RETRIEVAL_BASE_URL}/subjects/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        limit: options.limit,
        department_ids: options.departmentIds,
        date_from: options.dateFrom,
        date_to: options.dateTo,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`subject search HTTP ${response.status}`);
    const hits = (await response.json()) as Array<{ source_id: string; similarity: number }>;
    return hits.map((hit) => ({ sourceId: hit.source_id, similarity: hit.similarity }));
  });

// Read-only pool for order links (ADR-054) and order lists (ADR-057).
let relationsPool: Pool | undefined;
const getRelationsPool = () => (relationsPool ??= createPool());

interface DocumentCard {
  sourceId: string;
  title: string | null;
  department: string | null;
  goNumber: string | null;
  goDate: string | null;
  sourceUrl: string;
  jurisdictionCode: string | null;
  status: string | null;
}

/** Title, number and link of archived documents, in the order asked. */
async function documentCards(sourceIds: string[]): Promise<DocumentCard[]> {
  if (!sourceIds.length) return [];
  const result = await getRelationsPool().query<DocumentCard>(
    `SELECT source_id AS "sourceId",
            COALESCE(NULLIF(metadata->>'title', ''), NULLIF(metadata->'portal'->>'subject', '')) AS title,
            department, go_number AS "goNumber", go_date::text AS "goDate", source_url AS "sourceUrl",
            jurisdiction_code AS "jurisdictionCode", status
       FROM documents WHERE source_id = ANY($1)`,
    [sourceIds],
  );
  const byId = new Map(result.rows.map((row) => [row.sourceId, row]));
  return sourceIds.map((id) => byId.get(id)).filter((row): row is DocumentCard => Boolean(row));
}

/** Whether a document's text is in the search index (routine orders are not). */
async function hasIndexedPages(sourceId: string): Promise<boolean> {
  const result = await getRelationsPool().query("SELECT 1 FROM pages WHERE source_id = $1 LIMIT 1", [sourceId]);
  return (result.rowCount ?? 0) > 0;
}

/** A source card for an answer that is not built from retrieved pages. */
function cardSource(card: DocumentCard, label: string, laterChanges: LaterChange[] = []) {
  return {
    label,
    sourceId: card.sourceId,
    documentTitle: card.title,
    pageNumber: 1,
    department: card.department,
    goNumber: card.goNumber,
    goDate: card.goDate,
    // Rulebook §1: government URLs only; never our archive.
    sourceUrl: officialOnly(card.sourceUrl),
    pageUrl: officialOnly(card.sourceUrl) ? `${card.sourceUrl}#page=1` : null,
    numericConflict: false,
    numericVerificationStatus: "unverified",
    selectedVariant: "native",
    selectedCanonical: true,
    rerankScoreRaw: 0,
    retrievalRole: "direct",
    anchorPageNumber: null,
    kind: "listing",
    laterChanges,
    jurisdictionCode: card.jurisdictionCode,
    status: card.status,
  };
}


const ConversationStateSchema = z.object({
  activeSourceId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional(),
  activeDepartment: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional(),
});

const ChatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum([
          "user",
          "assistant",
        ]),
        content: z.string().min(1),
      }),
    )
    .min(1),
  conversationState:
    ConversationStateSchema.optional(),
  workspaceUserId:
    z.string()
      .uuid()
      .optional(),
  // Regenerate asks the model for a fresh draft of the same question.
  regenerate:
    z.boolean()
      .optional(),
});

const SearchFiltersSchema = z.object({
  department: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional(),
  departments: z
    .array(
      z.string()
        .trim()
        .min(1)
        .max(200),
    )
    .min(1)
    .max(12)
    .optional(),
  // Shasanadesh department IDs from the registry (ADR-057), with a label for
  // progress messages.
  departmentIds: z.array(z.number().int().positive()).min(1).max(12).optional(),
  // ADR-064: "IN" (Government of India), "UP", … and topic codes.
  jurisdictionCodes: z.array(z.string().trim().regex(/^[A-Za-z]{2}$/)).min(1).max(10).optional(),
  topics: z.array(z.string().trim().regex(/^[a-z-]{2,40}$/)).min(1).max(10).optional(),
  departmentLabel: z.string().trim().min(1).max(200).optional(),
  goNumber: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional(),
  sourceId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional(),
  // Source collections (documents.provider), e.g. "shasanadesh-up", "upgov".
  providers: z
    .array(z.string().trim().regex(/^[a-z0-9-]{2,40}$/))
    .min(1)
    .max(8)
    .optional(),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  verificationStatus: z
    .enum([
      "conflict",
      "ocr_only_unverified",
      "variants_agree",
      "native_primary",
      "unverified",
    ])
    .optional(),
  // Include tier C (routine/individual orders). The internal Search page sets
  // this; chat never does.
  includeRoutine: z.boolean().optional(),
});

type SearchFilters = z.infer<
  typeof SearchFiltersSchema
>;

const SearchBodySchema = z.object({
  query: z.string().min(1),
  topK: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional(),
  filters:
    SearchFiltersSchema.optional(),
});

interface RetrievalOptions {
  /** Cancelled when the person stops the answer (ADR-059). */
  signal?: AbortSignal;
  expandNeighbors?: boolean;
  neighborRadius?: number;
  maxEvidencePages?: number;
}

type ProgressStage =
  | "searching"
  | "reading"
  | "writing"
  | "checking";

const PROGRESS_LABELS: Record<
  "en" | "hi",
  Record<ProgressStage, string>
> = {
  en: {
    searching: "Searching",
    reading: "Reading",
    writing: "Writing the answer from",
    checking: "Re-checking citations and numbers",
  },
  hi: {
    searching: "खोज रहे हैं",
    reading: "पढ़ रहे हैं",
    writing: "से उत्तर लिख रहे हैं",
    checking: "उद्धरण और संख्याएँ दोबारा जाँच रहे हैं",
  },
};

function progressLabel(
  stage: ProgressStage,
  language: "en" | "hi",
  detail?: string,
): string {
  const base = PROGRESS_LABELS[language][stage];

  if (!detail) {
    if (stage === "writing") {
      return language === "hi" ? "उत्तर लिख रहे हैं" : "Writing the answer";
    }
    return base;
  }

  // Hindi puts the object before the verb: "सभी विभागों में खोज रहे हैं".
  if (language === "hi") {
    return stage === "searching"
      ? `${detail} में ${base}`
      : `${detail} ${base}`;
  }

  return `${base} ${detail}`;
}

/**
 * What the progress line says while searching. It names the scope in the
 * answer's language (a mixed "Secondary Education, लोक निर्माण विभाग,
 * Agriculture…" list read badly), never shows internal IDs (Rulebook §1), and
 * says that the rulebooks are searched too (central + UP rules are always in
 * scope, ADR-062/064).
 */
function describeScope(
  scope: string,
  filters: SearchFilters | undefined,
  language: "en" | "hi",
): string {
  const hi = language === "hi";

  if (filters?.sourceId) {
    return hi ? "इस आदेश" : "this order";
  }

  const one = filters?.departmentLabel ?? filters?.department ?? (filters?.departments?.length === 1 ? filters.departments[0] : null);
  if (one) {
    const name = filters?.departmentLabel ? one : departmentNameIn(one, language);
    return hi ? `${name} के आदेशों और नियम-पुस्तकों` : `${name} orders and the rulebooks`;
  }

  if (filters?.departments?.length) {
    const count = filters.departments.length;
    return hi
      ? `आपके ${count} विभागों के आदेशों और नियम-पुस्तकों`
      : `orders of your ${count} departments and the rulebooks`;
  }

  return hi
    ? "सभी आदेशों और नियम-पुस्तकों"
    : "all orders and rulebooks";
}

function describeEvidence(
  evidence: { source_id: string }[],
  language: "en" | "hi",
): string {
  const orders = new Set(evidence.map((item) => item.source_id)).size;

  if (language === "hi") {
    return `${orders} ${orders === 1 ? "आदेश" : "आदेशों"} के ${evidence.length} पृष्ठ`;
  }

  return `${evidence.length} page${evidence.length === 1 ? "" : "s"} in ${orders} order${orders === 1 ? "" : "s"}`;
}

async function retrieve(
  query: string,
  topK = RAG_TOP_K,
  filters?: SearchFilters,
  options?: RetrievalOptions,
): Promise<RetrievalResponse> {
  return runLocalGpuExclusive(
    "retrieval",
    async () => {
      // Stopped while waiting for the GPU: do not start.
      options?.signal?.throwIfAborted();
      let response: Response;

      try {
        response = await fetch(
        `${RETRIEVAL_BASE_URL}/search`,
        {
          method: "POST",
          signal: options?.signal,
          headers: {
            "content-type":
              "application/json",
          },
          body: JSON.stringify({
            query,
            top_k: topK,
            candidate_count: 50,
            rerank_count: RAG_RERANK_COUNT,
            filters: {
              department:
                filters?.department,
              departments:
                filters?.departments,
              department_ids:
                filters?.departmentIds,
              jurisdiction_codes:
                filters?.jurisdictionCodes,
              topics:
                filters?.topics,
              go_number:
                filters?.goNumber,
              source_id:
                filters?.sourceId,
              providers:
                filters?.providers,
              date_from:
                filters?.dateFrom,
              date_to:
                filters?.dateTo,
              verification_status:
                filters?.verificationStatus,
              include_routine:
                filters?.includeRoutine ?? false,
            },
            expand_neighbors:
              options?.expandNeighbors ?? false,
            neighbor_radius:
              options?.neighborRadius ?? 1,
            max_evidence_pages:
              options?.maxEvidencePages ?? 7,
          }),
        },
      );
      } catch (error) {
        throw new Error(
          `Retrieval service is not reachable at ${RETRIEVAL_BASE_URL} ` +
            `(${error instanceof Error ? error.message : String(error)}). ` +
            "Start it with npm run retrieval:serve.",
        );
      }

      if (!response.ok) {
        const body =
          await response.text();

        throw new Error(
          `Retrieval service returned ${response.status}: ${body}`,
        );
      }

      const raw =
        (await response.json()) as
          RetrievalResponse;

      return enrichRetrievalResponse(raw);
    },
  );
}

async function generateCompletion(
  openai: OpenAI,
  messages: GeneratorMessage[],
  temperature: number,
  maxTokens = LLM_MAX_TOKENS,
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const run = async () => {
      // Stopped while waiting for the GPU: give the slot to the next question.
      signal?.throwIfAborted();
      let upstream;

      try {
        upstream =
          await openai.chat.completions.create({
            model: LLM_MODEL!,
            messages:
              messages as Parameters<
                typeof openai.chat.completions.create
              >[0]["messages"],
            temperature,
            max_tokens: maxTokens,
            stream: true,
            ...LLM_EXTRA_BODY,
          } as Parameters<typeof openai.chat.completions.create>[0],
          // Aborting closes the model stream, so the model stops writing.
          { signal }) as unknown as AsyncIterable<{
            choices: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
          }>;
      } catch (error) {
        if (error instanceof OpenAI.APIConnectionError) {
          throw new Error(
            `Language model server is not reachable at ${LLM_BASE_URL}. ` +
              "Start it with npm run generator:serve.",
          );
        }

        throw error;
      }

      let answer = "";
      let finishReason: string | null = null;

      for await (const chunk of upstream) {
        const choice = chunk.choices[0];
        const token = choice?.delta?.content;

        if (token) {
          answer += token;
          onDelta?.(token);
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
      // The SDK ends the loop quietly when aborted; do not treat a stopped,
      // half-written draft as an answer (validation, repair would follow).
      signal?.throwIfAborted();

      // Stopped by max_tokens: cut back to the last complete sentence/bullet
      // rather than returning a half word (src/rag/truncation.ts).
      answer = stripThinking(answer);

      if (finishReason === "length") {
        const trimmed = trimIncompleteAnswer(answer);
        return { text: trimmed || answer.trim(), truncated: true };
      }

      return { text: answer.trim(), truncated: false };
  };

  return LLM_IS_LOCAL
    ? runLocalGpuExclusive("generation", run)
    : run();
}

function streamValidatedText(
  sendEvent: (
    event: string,
    data: unknown,
  ) => void,
  text: string,
): void {
  // The model answer is buffered until validation succeeds. We then emit modest
  // text chunks so the existing SSE client contract still behaves like streaming.
  const chunkSize = 96;
  // Rulebook §1: only government links ever reach the chat.
  text = stripNonGovernmentLinks(text);

  for (
    let offset = 0;
    offset < text.length;
    offset += chunkSize
  ) {
    sendEvent(
      "token",
      {
        text: text.slice(
          offset,
          offset + chunkSize,
        ),
      },
    );
  }
}

server.get(
  "/health",
  async () => {
    let retrieval: unknown;

    try {
      const response = await fetch(
        `${RETRIEVAL_BASE_URL}/health`,
      );

      retrieval = response.ok
        ? await response.json()
        : {
            ok: false,
            status: response.status,
          };
    } catch (error) {
      retrieval = {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }

    return {
      ok: true,
      retrieval,
      llmConfigured:
        Boolean(
          LLM_BASE_URL &&
          LLM_MODEL,
        ),
      llmBaseUrl:
        LLM_BASE_URL ?? null,
      llmModel:
        LLM_MODEL ?? null,
      answerValidation:
        "citation-and-numeric-safety-v1",
      localGpuQueue:
        getLocalGpuQueueStatus(),
    };
  },
);

server.post(
  "/api/search",
  async (request, reply) => {
    const parsed =
      SearchBodySchema.safeParse(
        request.body,
      );

    if (!parsed.success) {
      return reply.code(400).send({
        error:
          parsed.error.flatten(),
      });
    }

    return retrieve(
      parsed.data.query,
      parsed.data.topK ??
        RAG_TOP_K,
      parsed.data.filters,
    );
  },
);

// Follow-up questions under an answer (ADR-065). Asked by the browser after
// the answer is shown, so it never delays the answer. RAG_SUGGESTIONS=0 keeps
// only the fixed questions (no model call).
const RAG_SUGGESTIONS =
  (process.env.RAG_SUGGESTIONS ?? "1") !== "0";

const SuggestBodySchema = z.object({
  question: z.string().min(1).max(2000),
  answer: z.string().max(12000).default(""),
  language: z.enum(["hi", "en"]).default("en"),
  listing: z.boolean().optional(),
  sources: z
    .array(
      z.object({
        title: z.string().nullish(),
        goNumber: z.string().nullish(),
        goDate: z.string().nullish(),
        department: z.string().nullish(),
      }),
    )
    .max(12)
    .default([]),
});

server.post(
  "/api/suggest",
  async (request, reply) => {
    const parsed =
      SuggestBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const body = parsed.data;

    if (body.listing) {
      return { suggestions: listingSuggestions(body), source: "listing" };
    }

    // Someone else is waiting for the GPU: their answer matters more.
    const queue = getLocalGpuQueueStatus();
    const gpuBusy = LLM_IS_LOCAL && queue.enabled && queue.waiting > 0;

    if (!RAG_SUGGESTIONS || !LLM_BASE_URL || !LLM_MODEL || gpuBusy) {
      return { suggestions: fallbackSuggestions(body), source: "fixed" };
    }

    const stop = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) stop.abort();
    });

    try {
      const openai = new OpenAI({
        baseURL: LLM_BASE_URL,
        apiKey: LLM_API_KEY || "local-openai-compatible-endpoint",
        timeout: 20_000,
      });
      const { text } = await generateCompletion(
        openai,
        buildSuggestionMessages(body) as GeneratorMessage[],
        0.4,
        160,
        undefined,
        stop.signal,
      );
      const suggestions = parseSuggestions(text, body);

      return suggestions.length >= 2
        ? { suggestions, source: "model" }
        : { suggestions: fallbackSuggestions(body), source: "fixed" };
    } catch (error) {
      if (stop.signal.aborted) return reply.code(499).send();
      request.log.warn({ err: error }, "suggestions failed; using fixed questions");
      return { suggestions: fallbackSuggestions(body), source: "fixed" };
    }
  },
);

server.post(
  "/api/chat",
  async (request, reply) => {
    const parsed =
      ChatBodySchema.safeParse(
        request.body,
      );

    if (!parsed.success) {
      return reply.code(400).send({
        error:
          parsed.error.flatten(),
      });
    }

    const messages =
      parsed.data.messages as
        ChatMessage[];

    const lastUserIndex =
      messages
        .map(
          (message) =>
            message.role,
        )
        .lastIndexOf("user");

    if (lastUserIndex === -1) {
      return reply.code(400).send({
        error:
          "At least one user message is required.",
      });
    }

    const conversationPlan =
      buildConversationQueryPlan(
        messages,
        lastUserIndex,
      );

    const query =
      conversationPlan
        .currentQuery;

    const responseLanguage =
      detectResponseLanguage(
        query,
      );

    const conversationIntent =
      classifyConversationIntent(
        query,
      );

    if (
      conversationIntent.intent ===
        "conversational" &&
      conversationIntent.kind
    ) {
      const text =
        buildConversationalReply(
          conversationIntent.kind,
          responseLanguage,
        );

      reply.hijack();

      reply.raw.statusCode =
        200;

      reply.raw.setHeader(
        "content-type",
        "text/event-stream; charset=utf-8",
      );

      reply.raw.setHeader(
        "cache-control",
        "no-cache, no-transform",
      );

      reply.raw.setHeader(
        "connection",
        "keep-alive",
      );

      reply.raw.setHeader(
        "x-accel-buffering",
        "no",
      );

      reply.raw.write(
        `event: sources\ndata: []\n\n`,
      );

      reply.raw.write(
        `event: token\ndata: ${JSON.stringify({
          text,
        })}\n\n`,
      );

      reply.raw.write(
        `event: done\ndata: ${JSON.stringify({
          ok: true,
          conversational:
            true,
          intent:
            conversationIntent.kind,
          responseLanguage,
          citations: [],
        })}\n\n`,
      );

      reply.raw.end();

      return;
    }

    if (
      !LLM_BASE_URL ||
      !LLM_MODEL
    ) {
      return reply.code(503).send({
        error:
          "Generator is not configured. " +
          "Set LLM_BASE_URL and LLM_MODEL. " +
          "LLM_API_KEY is optional for local OpenAI-compatible servers.",
      });
    }

    const conversationState =
      parsed.data
        .conversationState;

    const cookieSession =
      await resolveSessionFromCookie(
        request.headers
          .cookie,
      );

    // A caller-supplied workspace UUID is only honoured in development, for
    // scripts that call the API without a browser session. In production the
    // HttpOnly session is the only identity source.
    const effectiveWorkspaceUserId =
      cookieSession?.userId ??
      (process.env.NODE_ENV ===
      "production"
        ? undefined
        : parsed.data
            .workspaceUserId);

    let workspaceProfile:
      Awaited<
        ReturnType<
          typeof getWorkspaceProfile
        >
      > | null =
      cookieSession?.profile ??
      null;

    if (
      !workspaceProfile &&
      effectiveWorkspaceUserId
    ) {
      try {
        workspaceProfile =
          await getWorkspaceProfile(
            effectiveWorkspaceUserId,
          );
      } catch (error) {
        request.log.warn(
          {
            error,
            workspaceUserId:
              effectiveWorkspaceUserId,
          },
          "Workspace profile unavailable; continuing without profile scope.",
        );
      }
    }

    const knownDepartments =
      workspaceProfile
        ? await listDepartments()
        : [];

    let explicitSourceId =
      extractExplicitSourceId(
        query,
      );

    // "क्या इस आदेश में बाद में कोई संशोधन हुआ है?": the question is about the
    // document the conversation is on, not a new search for orders.
    const followedSourceId =
      !explicitSourceId &&
      conversationPlan.contextualized &&
      refersToEarlierDocument(query)
        ? conversationState?.activeSourceId
        : undefined;

    if (followedSourceId && asksAboutLaterChanges(query)) {
      const startedAt = performance.now();
      const answered = await (async () => {
        const [card] = await documentCards([followedSourceId]);
        if (!card) return null;
        const changes =
          (
            await findLaterChanges(getRelationsPool(), [
              { label: "S1", source_id: card.sourceId, go_number: card.goNumber, go_date: card.goDate },
            ] as never)
          ).get(card.sourceId) ?? [];
        const changingCards = await documentCards(changes.map((change) => change.bySourceId));
        const titles = new Map(changingCards.map((item) => [item.sourceId, item.title]));
        const text = buildLaterChangesAnswer(
          { sourceId: card.sourceId, title: card.title, goNumber: card.goNumber, goDate: card.goDate },
          changes.map((change) => ({ change, title: titles.get(change.bySourceId) ?? null })),
          responseLanguage,
        );
        const sources = [
          cardSource(card, "S1", changes),
          ...changes
            .map((change) => changingCards.find((item) => item.sourceId === change.bySourceId))
            .filter((item): item is DocumentCard => Boolean(item))
            .map((item, index) => cardSource(item, `S${index + 2}`)),
        ];
        return { text, sources };
      })().catch((error) => {
        request.log.warn({ error }, "later-changes lookup failed; answering with Ask");
        return null;
      });

      if (answered) {
        reply.hijack();
        reply.raw.statusCode = 200;
        reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
        reply.raw.setHeader("cache-control", "no-cache, no-transform");
        reply.raw.setHeader("connection", "keep-alive");
        reply.raw.setHeader("x-accel-buffering", "no");
        reply.raw.write(`event: sources\ndata: ${JSON.stringify(answered.sources)}\n\n`);
        reply.raw.write(`event: token\ndata: ${JSON.stringify({ text: stripNonGovernmentLinks(answered.text) })}\n\n`);
        reply.raw.write(
          `event: done\ndata: ${JSON.stringify({
            ok: true,
            laterChanges: true,
            validated: true,
            responseLanguage,
            retrievalScope: "active_source",
            citations: answered.sources.map((source) => `${source.label}:1`),
            timings: { totalMs: Math.round(performance.now() - startedAt) },
          })}\n\n`,
        );
        reply.raw.end();
        request.log.info({ query, sourceId: followedSourceId }, "answered later changes from order links");
        return;
      }
    }

    const explicitDepartment =
      findExplicitDepartment(
        query,
        knownDepartments,
      );

    const globalScopeRequested =
      requestsGlobalScope(
        query,
      );

    // A department named in English or Hindi ("basic education", "PWD", "कृषि
    // विभाग") that is not one of the archive's spellings (ADR-057).
    const registryDepartment =
      explicitDepartment ? null : findDepartmentMention(query);

    // "Recent / latest / dated … orders": answer from the order list.
    let listingRequest =
      explicitSourceId || followedSourceId ? null : detectListingRequest(query);

    // "शासनादेश संख्या 3/2024/… में क्या निर्देश है?": find the order by its
    // number, then answer from its own text (Ask, that order only). An order
    // whose text is not indexed (routine) gets its card and official link.
    if (listingRequest?.goNumber && asksWhatOrderSays(query)) {
      const found = await listOrders(getRelationsPool(), listingRequest, [], responseLanguage).catch(() => null);
      const orders = found?.outcome.orders ?? [];
      const target =
        orders.find((order) => listingRequest?.dateFrom && order.goDate === listingRequest.dateFrom) ??
        (orders.length === 1 ? orders[0] : undefined);
      if (target && (await hasIndexedPages(target.sourceId).catch(() => false))) {
        explicitSourceId = target.sourceId;
        listingRequest = null;
      }
    }

    if (listingRequest) {
      const startedAt = performance.now();
      const listed = await listOrders(
        getRelationsPool(),
        listingRequest,
        !globalScopeRequested && workspaceProfile?.defaultScope === "my_departments"
          ? workspaceProfile.departments
          : [],
        responseLanguage,
        searchSubjects,
      ).catch((error) => {
        request.log.warn({ error }, "order listing failed; answering with Ask");
        return null;
      });

      if (listed) {
        const orders = listed.outcome.orders;
        const laterChanges = await findLaterChanges(
          getRelationsPool(),
          orders.map((order, index) => ({
            label: `S${index + 1}`,
            source_id: order.sourceId,
            go_number: order.goNumber,
            go_date: order.goDate,
          })) as never,
        ).catch(() => new Map<string, LaterChange[]>());

        const sources = orders.map((order, index) => ({
          label: `S${index + 1}`,
          sourceId: order.sourceId,
          documentTitle: order.subject,
          pageNumber: 1,
          department: order.department,
          goNumber: order.goNumber,
          goDate: order.goDate,
          // Rulebook §1: government URLs only; never our archive.
          sourceUrl: officialOnly(order.sourceUrl),
          pageUrl: officialOnly(order.sourceUrl) ? `${order.sourceUrl}#page=1` : null,
          numericConflict: false,
          numericVerificationStatus: "unverified",
          selectedVariant: "native",
          selectedCanonical: true,
          rerankScoreRaw: 0,
          retrievalRole: "direct",
          anchorPageNumber: null,
          kind: "listing",
          laterChanges: laterChanges.get(order.sourceId) ?? [],
          jurisdictionCode: order.jurisdictionCode ?? null,
          status: order.status ?? null,
        }));

        reply.hijack();
        reply.raw.statusCode = 200;
        reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
        reply.raw.setHeader("cache-control", "no-cache, no-transform");
        reply.raw.setHeader("connection", "keep-alive");
        reply.raw.setHeader("x-accel-buffering", "no");
        reply.raw.write(`event: sources\ndata: ${JSON.stringify(sources)}\n\n`);
        reply.raw.write(`event: token\ndata: ${JSON.stringify({ text: stripNonGovernmentLinks(listed.text) })}\n\n`);
        reply.raw.write(
          `event: done\ndata: ${JSON.stringify({
            ok: true,
            listing: true,
            find: listingRequest.mode === "find",
            bestSimilarity: listed.outcome.bestSimilarity,
            validated: true,
            responseLanguage,
            retrievalScope: `listing_${listed.outcome.scope.kind}`,
            scopeFallback: listed.outcome.widened,
            listingTotal: listed.outcome.total,
            citations: sources.map((source) => `${source.label}:1`),
            timings: { totalMs: Math.round(performance.now() - startedAt) },
          })}\n\n`,
        );
        reply.raw.end();
        request.log.info(
          { query, listing: listingRequest, total: listed.outcome.total, scope: listed.outcome.scope.kind },
          "answered from the order list",
        );
        return;
      }
    }

    const activeSourceId =
      conversationPlan
        .contextualized
        ? conversationState
            ?.activeSourceId
        : undefined;

    const activeDepartment =
      conversationPlan
        .contextualized &&
      !activeSourceId
        ? conversationState
            ?.activeDepartment
        : undefined;

    let retrievalScope:
      | "explicit_source"
      | "explicit_department"
      | "active_source"
      | "active_department"
      | "workspace_departments"
      | "global" =
      "global";

    let retrievalFilters:
      SearchFilters | undefined;

    if (explicitSourceId) {
      retrievalScope =
        "explicit_source";

      retrievalFilters = {
        sourceId:
          explicitSourceId,
      };
    } else if (
      explicitDepartment
    ) {
      retrievalScope =
        "explicit_department";

      retrievalFilters = {
        department:
          explicitDepartment,
      };
    } else if (
      registryDepartment?.strength === "strong"
    ) {
      retrievalScope =
        "explicit_department";

      retrievalFilters = {
        departmentIds: [registryDepartment.department.id],
        departmentLabel: departmentLabel(registryDepartment.department, responseLanguage),
      };
    } else if (
      activeSourceId
    ) {
      retrievalScope =
        "active_source";

      retrievalFilters = {
        sourceId:
          activeSourceId,
      };
    } else if (
      activeDepartment
    ) {
      retrievalScope =
        "active_department";

      retrievalFilters = {
        department:
          activeDepartment,
      };
    } else if (
      !globalScopeRequested &&
      workspaceProfile
        ?.defaultScope ===
        "my_departments" &&
      workspaceProfile
        .departments.length >
        0
    ) {
      retrievalScope =
        "workspace_departments";

      retrievalFilters = {
        departments:
          workspaceProfile
            .departments,
      };
    }

    // ADR-064: a question that names one government ("central government rules
    // on …", "UP …") is answered from that jurisdiction's documents.
    const askedJurisdictions = jurisdictionsInQuery(query).codes;
    if (askedJurisdictions.length === 1) {
      retrievalFilters = { ...(retrievalFilters ?? {}), jurisdictionCodes: askedJurisdictions };
    }

    reply.hijack();

    reply.raw.statusCode =
      200;

    reply.raw.setHeader(
      "content-type",
      "text/event-stream; charset=utf-8",
    );

    reply.raw.setHeader(
      "cache-control",
      "no-cache, no-transform",
    );

    reply.raw.setHeader(
      "connection",
      "keep-alive",
    );

    reply.raw.setHeader(
      "x-accel-buffering",
      "no",
    );

    // Stop (ADR-059): when the browser closes the stream (the person pressed
    // Stop or left), cancel retrieval and generation so the local GPU is freed.
    const stop = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) stop.abort();
    });

    const sendEvent = (
      event: string,
      data: unknown,
    ) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(
        `event: ${event}\n`,
      );

      reply.raw.write(
        `data: ${JSON.stringify(data)}\n\n`,
      );
    };

    // Stream opens before retrieval so the browser can show progress while
    // the slow stages (reranking, generation) run.
    const sendStatus = (
      stage: ProgressStage,
      detail?: string,
    ) =>
      sendEvent("status", {
        stage,
        label: progressLabel(stage, responseLanguage, detail),
      });

    try {
    let sourceStickinessApplied =
      retrievalScope ===
        "active_source" ||
      retrievalScope ===
        "active_department";

    sendStatus(
      "searching",
      describeScope(
        retrievalScope,
        retrievalFilters,
        responseLanguage,
      ),
    );

    const retrievalStartedAt =
      performance.now();

    let retrieval =
      await retrieve(
        conversationPlan
          .retrievalQuery,
        RAG_TOP_K,
        retrievalFilters,
        {
          expandNeighbors: true,
          neighborRadius: RAG_NEIGHBOR_RADIUS,
          signal: stop.signal,
          maxEvidencePages: Math.max(
            RAG_TOP_K,
            RAG_MAX_EVIDENCE_PAGES,
          ),
        },
      );

    if (
      sourceStickinessApplied &&
      retrieval.evidence.length ===
        0
    ) {
      const fallbackFilters:
        SearchFilters | undefined =
        !globalScopeRequested &&
        workspaceProfile
          ?.defaultScope ===
          "my_departments" &&
        workspaceProfile
          .departments.length >
          0
          ? {
              departments:
                workspaceProfile
                  .departments,
            }
          : undefined;

      retrieval =
        await retrieve(
          conversationPlan
            .retrievalQuery,
          RAG_TOP_K,
          fallbackFilters,
          {
            expandNeighbors: true,
            neighborRadius: RAG_NEIGHBOR_RADIUS,
            signal: stop.signal,
            maxEvidencePages: Math.max(
              RAG_TOP_K,
              RAG_MAX_EVIDENCE_PAGES,
            ),
          },
        );

      sourceStickinessApplied =
        false;

      retrievalScope =
        fallbackFilters
          ? "workspace_departments"
          : "global";
    }

    // Relevance gate (src/rag/relevance.ts): drop pages that are not about the
    // question. The officer's departments are a preference, not a wall: when
    // nothing close is found there, search all departments once.
    let relevance =
      assessRelevance(
        retrieval.evidence,
        RAG_MIN_RELEVANCE,
      );
    let scopeFallback = false;

    if (
      retrievalScope ===
        "workspace_departments" &&
      relevance.kept.length === 0
    ) {
      sendStatus(
        "searching",
        describeScope("global", undefined, responseLanguage),
      );
      retrieval =
        await retrieve(
          conversationPlan
            .retrievalQuery,
          RAG_TOP_K,
          undefined,
          {
            expandNeighbors: true,
            neighborRadius: RAG_NEIGHBOR_RADIUS,
            signal: stop.signal,
            maxEvidencePages: Math.max(
              RAG_TOP_K,
              RAG_MAX_EVIDENCE_PAGES,
            ),
          },
        );
      retrievalScope = "global";
      scopeFallback = true;
      relevance =
        assessRelevance(
          retrieval.evidence,
          RAG_MIN_RELEVANCE,
        );
    }

    retrieval = {
      ...retrieval,
      evidence: relevance.kept,
    };

    const retrievalMs =
      performance.now() -
      retrievalStartedAt;

    const searchedAllDepartments =
      retrievalScope === "global";

    // "Not found" is an answer, not an error: no citations, no source cards.
    const sendNoEvidence = (
      reason: "no_relevant_pages" | "model_found_no_answer",
      generationMs = 0,
    ) => {
      const text =
        noEvidenceMessage(
          responseLanguage,
          searchedAllDepartments,
        );
      if (reason === "no_relevant_pages") {
        sendEvent("sources", []);
      }
      streamValidatedText(sendEvent, text);
      sendEvent("done", {
        ok: true,
        validated: true,
        noEvidence: true,
        noEvidenceReason: reason,
        scopeFallback,
        retrievalScope,
        bestRelevance:
          Number(relevance.best.toFixed(3)),
        citations: [],
        timings: {
          retrievalMs: Math.round(retrievalMs),
          embeddingMs: retrieval.timings?.embedding_ms ?? null,
          hybridSearchMs: retrieval.timings?.hybrid_search_ms ?? null,
          rerankMs: retrieval.timings?.rerank_ms ?? null,
          hydrationMs: retrieval.timings?.hydration_ms ?? null,
          generationMs: Math.round(generationMs),
          totalMs: Math.round(performance.now() - retrievalStartedAt),
        },
      });
      request.log.info(
        { query, retrievalScope, scopeFallback, reason, bestRelevance: relevance.best },
        "RAG chat: no evidence",
      );
    };

    if (retrieval.evidence.length === 0) {
      sendNoEvidence("no_relevant_pages");
      return;
    }

    sendStatus(
      "reading",
      describeEvidence(
        retrieval.evidence,
        responseLanguage,
      ),
    );

    // Later orders that supersede / amend / cancel / correct an evidence order.
    // A lookup failure only loses the warning; it never blocks the answer.
    const laterChanges: Map<string, LaterChange[]> =
      await findLaterChanges(getRelationsPool(), retrieval.evidence).catch((error) => {
        request.log.warn({ error }, "later-changes lookup failed");
        return new Map();
      });

    const evidenceContext =
      buildEvidenceContext(
        retrieval.evidence,
        laterChanges,
      );

    const generatorMessages:
      GeneratorMessage[] = [
        {
          role: "system",
          content:
            RAG_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: [
            "CONVERSATION CONTEXT:",
            conversationPlan
              .contextualized
              ? conversationPlan
                  .priorUserQuestions
                  .map(
                    (
                      item,
                      index,
                    ) =>
                      `Previous user question ${index + 1}: ${item}`,
                  )
                  .join("\n")
              : "No prior context needed for this question.",
            "",
            "IMPORTANT: conversation context and active-source hints are for resolving references only; they are not evidence.",
            "",
            "ACTIVE SOURCE HINT:",
            activeSourceId ??
              activeDepartment ??
              "none",
            "",
            "RESPONSE LANGUAGE:",
            responseLanguage === "hi"
              ? "Hindi"
              : "English",
            "",
            "CURRENT USER QUESTION:",
            query,
            "",
            "RETRIEVED EVIDENCE:",
            evidenceContext,
          ].join("\n"),
        },
      ];

    const openai =
      new OpenAI({
        baseURL:
          LLM_BASE_URL,
        apiKey:
          LLM_API_KEY ||
          "local-openai-compatible-endpoint",
        timeout:
          LLM_REQUEST_TIMEOUT_MS,
      });

    sendEvent(
      "sources",
      retrieval.evidence.map(
        (item) => ({
          label:
            item.label,
          sourceId:
            item.source_id,
          documentTitle:
            item.document_title ??
            null,
          pageNumber:
            item.page_number,
          department:
            item.department,
          goNumber:
            item.go_number,
          goDate:
            item.go_date,
          // Rulebook §1: government URLs only; never our archive.
          sourceUrl:
            officialOnly(item.source_url),
          pageUrl:
            officialOnly(item.page_url),
          legacyFont:
            Boolean(item.legacy_font),
          numericConflict:
            item.numeric_conflict,
          numericVerificationStatus:
            item.numeric_verification_status,
          selectedVariant:
            item.selected_variant,
          selectedCanonical:
            item.selected_canonical,
          rerankScoreRaw:
            item.rerank_score_raw,
          retrievalRole:
            item.retrieval_role ??
            "direct",
          anchorPageNumber:
            item.anchor_page_number ??
            null,
          laterChanges:
            laterChanges.get(item.source_id) ?? [],
          jurisdictionCode:
            item.jurisdiction_code ?? null,
          status:
            item.status ?? null,
        }),
      ),
    );

      const generationStartedAt =
      performance.now();

    let validationMs = 0;
    let repairMs = 0;

    const validateCurrentAnswer = (
      answer: string,
    ) => {
      const startedAt =
        performance.now();

      const result =
        validateAnswer(
          answer,
          retrieval.evidence,
        );

      validationMs +=
        performance.now() -
        startedAt;

      return result;
    };

    sendStatus(
      "writing",
      retrieval.evidence.length > 0
        ? describeEvidence(
            retrieval.evidence,
            responseLanguage,
          )
        : undefined,
    );

    const tokenBudget =
      answerTokenBudget(responseLanguage);

    // Unchecked preview of the first draft. Held back while it could still be
    // the NO_ANSWER_IN_EVIDENCE reply, and sent in small batches.
    // Unchecked preview of the first draft (src/rag/draft-preview.ts).
    const draftStreamer = RAG_STREAM_DRAFT
      ? createDraftStreamer((text) => sendEvent("draft", { text: stripNonGovernmentLinks(text) }))
      : null;
    const onDraftDelta = draftStreamer
      ? (delta: string) => draftStreamer.onDelta(delta)
      : undefined;

    const firstCompletion =
        await generateCompletion(
          openai,
          generatorMessages,
          parsed.data.regenerate
            ? REGENERATE_TEMPERATURE
            : LLM_TEMPERATURE,
          tokenBudget,
          onDraftDelta,
          stop.signal,
        );

    draftStreamer?.finish();

    const firstDraft =
      firstCompletion.text;

      const generationMs =
      performance.now() -
      generationStartedAt;

    // The prompt asks for NO_ANSWER_IN_EVIDENCE when the pages do not answer
    // the question; answer "not found" instead of validating a non-answer.
    if (isNoAnswer(firstDraft)) {
      sendNoEvidence("model_found_no_answer", generationMs);
      return;
    }

    const firstValidation =
        validateCurrentAnswer(firstDraft);

      let finalAnswer =
        firstDraft;

      // True when the answer shown was shortened at the token limit.
      let shortened =
        firstCompletion.truncated;

      let finalValidation =
        firstValidation;

      let repaired =
        false;

      let usedFallback =
        false;

      let usedQualitativeSalvage =
        false;

      let repairValidationIssues:
        string[] = [];

      // Try deterministic qualitative salvage before LLM repair.
      //
      // The salvage function can only keep citation-valid, non-numeric,
      // non-placeholder claim units, and the result must pass the same final
      // validator. If salvage cannot produce a valid answer, fall through to
      // the existing LLM repair path unchanged.
      if (!finalValidation.ok) {
        const preRepairSalvage =
          buildQualitativeSalvage(
            firstDraft,
            retrieval.evidence,
          );

        if (preRepairSalvage) {
          const salvageValidation =
            validateCurrentAnswer(
              preRepairSalvage,
            );

          if (salvageValidation.ok) {
            usedQualitativeSalvage =
              true;
            finalAnswer =
              preRepairSalvage;
            finalValidation =
              salvageValidation;
          }
        }
      }

      if (!finalValidation.ok) {
        repaired = true;

        sendStatus("checking");

        const repairMessages:
          GeneratorMessage[] = [
            ...generatorMessages,
            {
              role: "assistant",
              content: firstDraft,
            },
            {
              role: "user",
              content:
                buildAnswerRepairInstruction(
                  firstDraft,
                  firstValidation,
                ),
            },
          ];

        const repairStartedAt =
        performance.now();

      const repairCompletion =
          await generateCompletion(
            openai,
            repairMessages,
            0,
            LLM_REPAIR_MAX_TOKENS ?? tokenBudget,
            undefined,
            stop.signal,
          );

      const repairedAnswer =
        repairCompletion.text;

        repairMs +=
        performance.now() -
        repairStartedAt;

      const repairedValidation =
          validateCurrentAnswer(repairedAnswer);

        repairValidationIssues =
          repairedValidation.issues.map(
            (issue) => issue.code,
          );

        finalAnswer =
          repairedAnswer;

        shortened =
          repairCompletion.truncated;

        finalValidation =
          repairedValidation;
      }

      if (!finalValidation.ok) {
        const qualitativeSalvage =
          buildQualitativeSalvage(
            finalAnswer,
            retrieval.evidence,
          );

        if (qualitativeSalvage) {
          const salvageValidation =
            validateCurrentAnswer(qualitativeSalvage);

          if (salvageValidation.ok) {
            usedQualitativeSalvage =
              true;
            finalAnswer =
              qualitativeSalvage;
            finalValidation =
              salvageValidation;
            repairValidationIssues =
              [];
          }
        }
      }

      if (!finalValidation.ok) {
        usedFallback = true;

        finalAnswer =
          buildConservativeFallback(
            retrieval.evidence,
            responseLanguage,
          );

        finalValidation =
          validateCurrentAnswer(finalAnswer);
      }

      // A fallback is intentionally simple enough to pass the same deterministic
      // gate. If it does not, fail closed instead of releasing unsafe answer text.
      if (!finalValidation.ok) {
        throw new Error(
          "Answer safety validation failed after repair and fallback.",
        );
      }

      streamValidatedText(
        sendEvent,
        finalAnswer,
      );

      const totalMs =
      performance.now() -
      retrievalStartedAt;

    const ragTimings = {
      retrievalMs:
        Math.round(retrievalMs),
      embeddingMs:
        retrieval.timings
          ?.embedding_ms ??
        null,
      hybridSearchMs:
        retrieval.timings
          ?.hybrid_search_ms ??
        null,
      rerankMs:
        retrieval.timings
          ?.rerank_ms ??
        null,
      hydrationMs:
        retrieval.timings
          ?.hydration_ms ??
        null,
      retrievalServiceMs:
        retrieval.timings
          ?.total_ms ??
        null,
      generationMs:
        Math.round(
          generationMs,
        ),
      repairMs:
        Math.round(
          repairMs,
        ),
      validationMs:
        Math.round(
          validationMs,
        ),
      totalMs:
        Math.round(totalMs),
    };

    request.log.info(
      {
        query,
        retrievalScope,
        evidencePages:
          retrieval.evidence.length,
        repaired,
        usedQualitativeSalvage,
        usedFallback,
        timings:
          ragTimings,
      },
      "RAG chat timing",
    );

    sendEvent(
        "done",
        {
        timings:
          ragTimings,
          ok: true,
          validated: true,
          repaired,
          usedFallback,
          usedQualitativeSalvage,
          citations:
            finalValidation.citations,
          firstValidationIssues:
            firstValidation.issues.map(
              (issue) => issue.code,
            ),
          repairValidationIssues,
          // Salvage and fallback texts are built whole, never shortened.
          shortened:
            shortened &&
            !usedFallback &&
            !usedQualitativeSalvage,
          scopeFallback,
          retrievalScope,
          bestRelevance:
            Number(relevance.best.toFixed(3)),
        },
      );
    } catch (error) {
      if (stop.signal.aborted) {
        request.log.info({ query }, "answer stopped by the user");
        return;
      }
      sendEvent(
        "error",
        {
          message:
            error instanceof Error
              ? error.message
              : String(error),
        },
      );
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  },
);

async function start():
  Promise<void> {
  await server.listen({
    port: PORT,
    host: "127.0.0.1",
  });

  console.log(
    `Shasanadesh RAG API listening on http://127.0.0.1:${PORT}`,
  );
}

start().catch((error) => {
  server.log.error(error);
  process.exit(1);
});
