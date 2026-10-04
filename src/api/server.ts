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
  purgeDeletedProfiles,
} from "../workspace/store.js";
import {
  getLocalGpuQueueStatus,
  runLocalGpuExclusive,
} from "./local-gpu-queue.js";
import {
  buildAnswerRepairInstruction,
  buildQualitativeSalvage,
  buildConservativeFallback,
  stripVerificationNotes,
  validateAnswer,
} from "../rag/answer-validation.js";
import {
  authorityLabel,
  buildEvidenceContext,
  RAG_SYSTEM_PROMPT,
} from "../rag/prompt.js";
import type {
  ChatMessage,
  RetrievalEvidence,
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
import { expandSearchQuery } from "../rag/query-expansion.js";
import { matchPlaybook, type PlaybookMatch, type PlaybookPage } from "../rag/playbooks.js";
import { mergeNamedPages, missingNamedSources, namedSources } from "../rag/named-sources.js";
import {
  amendmentPrompt,
  amendmentsFor,
  appendEvidence,
  cardAmendments,
  missingPages,
  type CardAmendment,
} from "../rag/amendments.js";
import {
  PROCUREMENT_PROMPT,
  PROCUREMENT_RULEBOOKS_ENABLED,
  PROCUREMENT_SOURCE_IDS,
  isProcurementQuestion,
  orderByAuthority,
  procurementBooksToCheck,
} from "../rag/procurement.js";
import {
  buildGeneralKnowledgeMessages,
  cleanGeneralKnowledgeAnswer,
  closestDocuments,
  closestDocumentsFooter,
  GENERAL_KNOWLEDGE_ENABLED,
} from "../rag/general-knowledge.js";
import { assessRelevance, followUpNotCoveredMessage, hasEvidenceFromDepartments, isNoAnswer, isProseNonAnswer, noEvidenceMessage, withoutNoAnswerToken } from "../rag/relevance.js";
import { trimIncompleteAnswer } from "../rag/truncation.js";
import { findLaterChanges, type LaterChange } from "../rag/later-changes.js";
import { asksWhatOrderSays, detectListingRequest, jurisdictionsInQuery, listOrders, type SubjectSearch } from "../rag/order-listing.js";
import { asksAboutLaterChanges, buildLaterChangesAnswer, refersToEarlierDocument } from "../rag/document-followup.js";
import { departmentLabel, departmentNameIn, departmentSpellings, findDepartmentMention } from "../departments/registry.js";
import { createPool } from "../db/client.js";
import { officialOnly, stripNonGovernmentLinks } from "../lib/public-links.js";
import type { Pool } from "pg";
import { createDraftStreamer, stripThinking } from "../rag/draft-preview.js";
import { clientFor, readLlmTargets, shouldFallBack, type LlmTarget } from "../rag/llm-targets.js";
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

// Answer-writing model servers: a primary and an optional fallback
// (src/rag/llm-targets.ts, ADR-075). LLM_PROVIDER=openrouter writes on
// OpenRouter with the local MLX Qwen as fallback.
const LLM_TARGETS = readLlmTargets();
const LLM_PRIMARY = LLM_TARGETS[0] ?? null;
const LLM_BASE_URL = LLM_PRIMARY?.baseURL;

// Generation only needs to share the Apple GPU with retrieval when the model
// runs on this machine. A hosted endpoint runs in parallel with retrieval.
const LLM_IS_LOCAL = LLM_PRIMARY?.local ?? true;

// Stream the first draft to the browser as a clearly marked, unchecked preview
// while it is written; the validated answer replaces it (RAG_STREAM_DRAFT=0 to
// turn off).
const RAG_STREAM_DRAFT =
  (process.env.RAG_STREAM_DRAFT ?? "1") !== "0";

const LLM_MODEL =
  LLM_PRIMARY?.model;

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

// Routine (tier C) orders in chat retrieval, ranked below rules and general
// orders (ADR-081). "0" leaves confident routine orders out of chat again.
const RAG_CHAT_INCLUDE_ROUTINE = process.env.RAG_CHAT_INCLUDE_ROUTINE !== "0";

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
  // A suggested question clicked under the previous answer: a follow-up on
  // the same orders (conversation context + the cited order first).
  followUp:
    z.boolean()
      .optional(),
  // The orders the previous answer cited: a suggested follow-up is answered
  // from these only, never from other departments or orders.
  followSourceIds:
    z.array(z.string().trim().min(1).max(200))
      .max(8)
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
  // Several orders: a suggested follow-up searches only the cited orders.
  sourceIds: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(8)
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
  /** Chat: rank rulebooks and general orders above specific ones (ADR-078). */
  preferAuthority?: boolean;
  /** The question in official wording, English and Hindi (ADR-082). */
  expansions?: string[];
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

  if (filters?.sourceIds?.length) {
    return hi ? "पिछले उत्तर में उद्धृत आदेशों" : "the orders cited in the previous answer";
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
            // More wordings bring more candidates; rerank a few more of them.
            rerank_count: options?.expansions?.length
              ? Math.min(100, RAG_RERANK_COUNT + 12)
              : RAG_RERANK_COUNT,
            filters: {
              department:
                filters?.department,
              // Every spelling of the chosen departments ("कृषि विभाग" also
              // matches documents filed under "Agriculture").
              departments:
                filters?.departments
                  ? departmentSpellings(filters.departments)
                  : undefined,
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
              source_ids:
                filters?.sourceIds,
              providers:
                filters?.providers,
              date_from:
                filters?.dateFrom,
              date_to:
                filters?.dateTo,
              verification_status:
                filters?.verificationStatus,
              // Chat ranks by authority (ADR-078/081): routine orders take part
              // with a penalty, so one clearly asked about can still answer.
              include_routine:
                filters?.includeRoutine ??
                (options?.preferAuthority === true && RAG_CHAT_INCLUDE_ROUTINE),
            },
            expand_neighbors:
              options?.expandNeighbors ?? false,
            neighbor_radius:
              options?.neighborRadius ?? 1,
            max_evidence_pages:
              options?.maxEvidencePages ?? 7,
            prefer_authority:
              options?.preferAuthority ?? false,
            expansions:
              options?.expansions ?? [],
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

/** The exact pages a playbook names (ADR-091), scored against the question. */
async function fetchPlaybookPages(
  question: string,
  pages: PlaybookPage[],
  signal?: AbortSignal,
): Promise<RetrievalResponse> {
  return runLocalGpuExclusive("retrieval", async () => {
    signal?.throwIfAborted();
    const response = await fetch(`${RETRIEVAL_BASE_URL}/pages`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: question,
        pages: pages.map((page) => ({ source_id: page.sourceId, page_number: page.pageNumber })),
      }),
    });
    if (!response.ok) {
      throw new Error(`Retrieval service returned ${response.status} for playbook pages: ${await response.text()}`);
    }
    return enrichRetrievalResponse((await response.json()) as RetrievalResponse);
  });
}

async function generateCompletion(
  timeoutMs: number,
  messages: GeneratorMessage[],
  temperature: number,
  maxTokens = LLM_MAX_TOKENS,
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean; model: string; fellBack: boolean }> {
  const runOn = async (target: LlmTarget, onWritten: () => void) => {
      // Stopped while waiting for the GPU: give the slot to the next question.
      signal?.throwIfAborted();
      const openai = clientFor(target, timeoutMs);
      let upstream;

      try {
        upstream =
          await openai.chat.completions.create({
            model: target.model,
            messages:
              messages as Parameters<
                typeof openai.chat.completions.create
              >[0]["messages"],
            temperature,
            max_tokens: maxTokens,
            stream: true,
            ...target.extraBody,
          } as Parameters<typeof openai.chat.completions.create>[0],
          // Aborting closes the model stream, so the model stops writing.
          { signal }) as unknown as AsyncIterable<{
            choices: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
          }>;
      } catch (error) {
        if (error instanceof OpenAI.APIConnectionError && target.local) {
          const wrapped = new Error(
            `Language model server is not reachable at ${target.baseURL}. ` +
              "Start it with npm run generator:serve.",
          );
          (wrapped as Error & { cause?: unknown }).cause = error;
          throw Object.assign(wrapped, { fallbackWorthy: true });
        }

        throw error;
      }

      let answer = "";
      let finishReason: string | null = null;

      for await (const chunk of upstream) {
        const choice = chunk.choices[0];
        const token = choice?.delta?.content;

        if (token) {
          if (!answer) onWritten();
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

  if (!LLM_TARGETS.length) throw new Error("No language model is configured (LLM_PROVIDER or LLM_BASE_URL/LLM_MODEL).");
  let lastError: unknown;
  for (const [index, target] of LLM_TARGETS.entries()) {
    let written = false;
    try {
      const run = () => runOn(target, () => { written = true; });
      const result = target.local ? await runLocalGpuExclusive("generation", run) : await run();
      return { ...result, model: target.label, fellBack: index > 0 };
    } catch (error) {
      lastError = error;
      const worthy = shouldFallBack(error) || (error as { fallbackWorthy?: boolean }).fallbackWorthy === true;
      // Never stitch an answer from two models, and never retry a stop.
      if (signal?.aborted || written || !worthy || index === LLM_TARGETS.length - 1) throw error;
      console.warn(
        `Answer model ${target.label} failed (${error instanceof Error ? error.message : String(error)}); using ${LLM_TARGETS[index + 1].label}.`,
      );
    }
  }
  throw lastError;
}

/** A source card for the chat (Rulebook §1: official URLs only). */
function sourceCard(
  item: RetrievalEvidence,
  laterChanges: Map<string, LaterChange[]>,
  ruleAmendments?: Map<string, CardAmendment[]>,
) {
  return ({
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
          ruleAmendments: ruleAmendments?.get(item.source_id),
          jurisdictionCode:
            item.jurisdiction_code ?? null,
          status:
            item.status ?? null,
          // RULEBOOK / GENERAL / CONTEXT / SPECIFIC (ADR-078).
          authority:
            authorityLabel(item),
        });
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
      llmFallback:
        LLM_TARGETS[1]?.label ?? null,
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
      const { text } = await generateCompletion(
        20_000,
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
        { followUp: parsed.data.followUp },
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
    // A clicked suggestion: only the orders the previous answer cited.
    const followSourceIds =
      parsed.data.followUp && parsed.data.followSourceIds?.length
        ? [...new Set(parsed.data.followSourceIds)]
        : null;

    let listingRequest =
      explicitSourceId || followedSourceId || followSourceIds ? null : detectListingRequest(query);

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
      | "playbook"
      | "procurement_rulebooks"
      | "global" =
      "global";

    let retrievalFilters:
      SearchFilters | undefined;

    if (followSourceIds) {
      retrievalScope =
        "explicit_source";

      retrievalFilters = {
        sourceIds: followSourceIds,
      };
    } else if (explicitSourceId) {
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

    // The question in official wording (ADR-082), for normal questions only:
    // a cited-order follow-up or an explicit order is searched as asked.
    // It also fixes typos and grammar in the question (ADR-086); the corrected
    // question is what is searched, reranked against and answered.
    // A topic playbook (ADR-091) answers from its own checked pages: no search,
    // and no rewording call when the question already matches as typed.
    const searchable = !followSourceIds && !explicitSourceId;
    let playbookMatch: PlaybookMatch | null = searchable
      ? matchPlaybook(conversationPlan.retrievalQuery) ?? matchPlaybook(query)
      : null;
    const searchPlan =
      !searchable || playbookMatch
        ? { corrected: null, expansions: [] as string[] }
        : await expandSearchQuery(conversationPlan.retrievalQuery, stop.signal);
    if (!playbookMatch && searchPlan.corrected) playbookMatch = matchPlaybook(searchPlan.corrected);
    const expansions = searchPlan.expansions;
    const searchQuestion = searchPlan.corrected ?? conversationPlan.retrievalQuery;
    // Each pass costs several seconds on the Mac; shown in the latency panel.
    let searchPasses = 0;
    const searchChat: typeof retrieve = (...args) => {
      searchPasses++;
      return retrieve(...args);
    };
    const expansionMs = performance.now() - retrievalStartedAt;

    // Playbook pages instead of a search (ADR-091). If they cannot be read
    // (service older than the playbook endpoint, pages not loaded), search.
    const playbookPages = playbookMatch
      ? await fetchPlaybookPages(searchQuestion, playbookMatch.playbook.pages, stop.signal).catch((error) => {
          request.log.warn({ err: error, playbook: playbookMatch?.playbook.id }, "playbook pages unavailable; searching");
          return null;
        })
      : null;
    const usingPlaybook = Boolean(playbookPages && playbookPages.evidence.length > 0);
    if (usingPlaybook) {
      retrievalScope = "playbook";
      sourceStickinessApplied = false;
    }

    // Procurement questions search the procurement rule books only, in their
    // order of authority (ADR-093). Not when the officer asked about a named
    // order, department or the order already under discussion.
    let procurementSearch =
      PROCUREMENT_RULEBOOKS_ENABLED &&
      searchable &&
      !usingPlaybook &&
      (retrievalScope === "global" || retrievalScope === "workspace_departments") &&
      isProcurementQuestion(`${query} ${searchQuestion}`);
    let procurementRetrieval: RetrievalResponse | null = null;
    if (procurementSearch) {
      procurementRetrieval = await searchChat(
        searchQuestion,
        RAG_TOP_K + 3,
        { sourceIds: PROCUREMENT_SOURCE_IDS },
        {
          expandNeighbors: true,
          neighborRadius: RAG_NEIGHBOR_RADIUS,
          signal: stop.signal,
          preferAuthority: true,
          expansions,
          maxEvidencePages: Math.max(RAG_TOP_K, RAG_MAX_EVIDENCE_PAGES) + 3,
        },
      );
      if (assessRelevance(procurementRetrieval.evidence, RAG_MIN_RELEVANCE).kept.length === 0) {
        // Nothing in the rule books: search everything as usual.
        procurementSearch = false;
        procurementRetrieval = null;
      } else {
        retrievalScope = "procurement_rulebooks";
        sourceStickinessApplied = false;
      }
    }

    let retrieval: RetrievalResponse =
      procurementRetrieval ??
      (usingPlaybook && playbookPages
        ? playbookPages
        : await searchChat(
            searchQuestion,
            RAG_TOP_K,
            retrievalFilters,
            {
              expandNeighbors: true,
              neighborRadius: RAG_NEIGHBOR_RADIUS,
              signal: stop.signal,
              preferAuthority: true,
              expansions,
              maxEvidencePages: Math.max(
                RAG_TOP_K,
                RAG_MAX_EVIDENCE_PAGES,
              ),
            },
          ));

    // The conversation's order (or department) first; when none of its pages
    // is about the question, search the usual scope instead.
    if (
      sourceStickinessApplied &&
      assessRelevance(retrieval.evidence, RAG_MIN_RELEVANCE).kept.length === 0
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
        await searchChat(
          searchQuestion,
          RAG_TOP_K,
          fallbackFilters,
          {
            expandNeighbors: true,
            neighborRadius: RAG_NEIGHBOR_RADIUS,
            signal: stop.signal,
            preferAuthority: true,
          expansions,
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

    // A rulebook named in the question ("as per GeM GTC") but absent from
    // the pages found: search inside it and put its best pages first, so the
    // answer can cite the book the officer asked about (ADR-091).
    const namedSourcesAdded: string[] = [];
    if (searchable && !usingPlaybook) {
      const asked = namedSources(`${query} ${searchQuestion}`);
      if (procurementSearch) {
        for (const book of procurementBooksToCheck(`${query} ${searchQuestion}`)) {
          if (!asked.some((source) => source.name === book.name)) asked.push(book);
        }
      }
      const missing = missingNamedSources(asked, retrieval.evidence);
      for (const source of missing.slice(0, 3)) {
        try {
          const inBook = await searchChat(
            searchQuestion,
            4,
            { sourceIds: source.sourceIds },
            { expandNeighbors: false, signal: stop.signal, preferAuthority: true },
          );
          const best = inBook.evidence
            .filter((item) => item.retrieval_role !== "neighbor")
            .filter((item) => assessRelevance([item], RAG_MIN_RELEVANCE).kept.length > 0)
            .slice(0, 2);
          if (best.length) {
            retrieval = mergeNamedPages(retrieval, best, Math.max(RAG_TOP_K, RAG_MAX_EVIDENCE_PAGES));
            namedSourcesAdded.push(source.name);
          }
        } catch (error) {
          if (stop.signal.aborted) throw error;
          request.log.warn({ err: error, source: source.name }, "named rulebook search failed");
        }
      }
    }

    if (procurementSearch || usingPlaybook) retrieval = orderByAuthority(retrieval);

    // Relevance gate (src/rag/relevance.ts): drop pages that are not about the
    // question. The officer's departments are a preference, not a wall: when
    // nothing close is found there, search all departments once.
    // A suggested follow-up keeps every page found in the cited orders: the
    // question is about those orders, and the model says when they do not
    // answer it (no widening to other orders).
    let relevance = followSourceIds || usingPlaybook
      ? {
          kept: retrieval.evidence,
          dropped: 0,
          best: assessRelevance(retrieval.evidence, RAG_MIN_RELEVANCE).best,
        }
      : assessRelevance(
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
        await searchChat(
          searchQuestion,
          RAG_TOP_K,
          undefined,
          {
            expandNeighbors: true,
            neighborRadius: RAG_NEIGHBOR_RADIUS,
            signal: stop.signal,
            preferAuthority: true,
          expansions,
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

    // Something was found, but only rulebook / central pages (they pass every
    // department filter), nothing from the officer's own departments: the
    // question is probably about another department ("seniority of medical
    // officers" asked from Education). Search all departments once and keep
    // whichever search matches the question better.
    if (
      retrievalScope === "workspace_departments" &&
      relevance.kept.length > 0 &&
      !hasEvidenceFromDepartments(relevance.kept, workspaceProfile?.departments ?? [])
    ) {
      sendStatus(
        "searching",
        describeScope("global", undefined, responseLanguage),
      );
      const wide = await searchChat(
        searchQuestion,
        RAG_TOP_K,
        undefined,
        {
          expandNeighbors: true,
          neighborRadius: RAG_NEIGHBOR_RADIUS,
          signal: stop.signal,
          preferAuthority: true,
          expansions,
          maxEvidencePages: Math.max(RAG_TOP_K, RAG_MAX_EVIDENCE_PAGES),
        },
      );
      const wideRelevance = assessRelevance(wide.evidence, RAG_MIN_RELEVANCE);
      if (wideRelevance.kept.length > 0 && wideRelevance.best >= relevance.best) {
        retrieval = wide;
        relevance = wideRelevance;
        retrievalScope = "global";
        scopeFallback = true;
      }
    }

    // Kept for the general-knowledge answer's "closest documents" (ADR-083).
    const retrievedBeforeGate = retrieval.evidence;

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
      reason: "no_relevant_pages" | "model_found_no_answer" | "model_prose_non_answer",
      generationMs = 0,
    ) => {
      const text = followSourceIds
        ? followUpNotCoveredMessage(responseLanguage)
        : noEvidenceMessage(
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
        correctedQuestion: searchPlan.corrected,
        scopeFallback,
        retrievalScope,
        bestRelevance:
          Number(relevance.best.toFixed(3)),
        citations: [],
        timings: {
          retrievalMs: Math.round(retrievalMs),
          searchPasses,
          expansionMs: Math.round(expansionMs),

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

    // No archived page answers: answer from general knowledge, clearly
    // marked, instead of a dead end (ADR-083). Not for a cited-order
    // follow-up (the web app re-asks it over all orders) or an explicit order.
    const answerFromGeneralKnowledge = async (
      reason: "no_relevant_pages" | "model_found_no_answer" | "model_prose_non_answer",
    ): Promise<boolean> => {
      if (!GENERAL_KNOWLEDGE_ENABLED || followSourceIds || explicitSourceId) return false;
      const primary = readLlmTargets()[0];
      if (!primary || primary.local) return false;
      const startedAt = performance.now();
      sendStatus("writing");
      const closest = closestDocuments(retrievedBeforeGate, 3, RAG_MIN_RELEVANCE);
      try {
        const completion = await generateCompletion(
          LLM_REQUEST_TIMEOUT_MS,
          buildGeneralKnowledgeMessages(searchQuestion, responseLanguage, closest),
          LLM_TEMPERATURE,
          answerTokenBudget(responseLanguage),
          undefined,
          stop.signal,
        );
        const body = cleanGeneralKnowledgeAnswer(completion.text);
        if (!body) return false;

        // Second chance (ADR-089): the general-knowledge draft is worded like
        // the rule, so search once more with it. If that finds pages the first
        // search did not and they answer the question, give a normal cited
        // answer from them instead of the general-knowledge one.
        try {
          sendStatus("searching", describeScope("global", undefined, responseLanguage));
          const second = await searchChat(searchQuestion, RAG_TOP_K, undefined, {
            expandNeighbors: true,
            neighborRadius: RAG_NEIGHBOR_RADIUS,
            signal: stop.signal,
            preferAuthority: true,
            expansions: [...expansions, body.slice(0, 600)],
            maxEvidencePages: Math.max(RAG_TOP_K, RAG_MAX_EVIDENCE_PAGES),
          });
          const secondRelevance = assessRelevance(second.evidence, RAG_MIN_RELEVANCE);
          const seenPages = new Set(retrievedBeforeGate.map((item) => `${item.source_id}#${item.page_number}`));
          const freshPages = secondRelevance.kept.filter(
            (item) => item.retrieval_role !== "neighbor" && !seenPages.has(`${item.source_id}#${item.page_number}`),
          );
          if (freshPages.length > 0 && secondRelevance.best >= 0.5) {
            const evidence = secondRelevance.kept;
            const changes: Map<string, LaterChange[]> = await findLaterChanges(getRelationsPool(), evidence).catch(
              () => new Map(),
            );
            sendStatus("writing");
            const cited = await generateCompletion(
              LLM_REQUEST_TIMEOUT_MS,
              [
                { role: "system", content: RAG_SYSTEM_PROMPT },
                {
                  role: "user",
                  content: [
                    "RESPONSE LANGUAGE:",
                    responseLanguage === "hi" ? "Hindi" : "English",
                    "",
                    "CURRENT USER QUESTION:",
                    searchPlan.corrected ? `${query}\n(The same question with typos and grammar fixed: ${searchPlan.corrected})` : query,
                    "",
                    "RETRIEVED EVIDENCE:",
                    buildEvidenceContext(evidence, changes),
                  ].join("\n"),
                },
              ],
              LLM_TEMPERATURE,
              answerTokenBudget(responseLanguage),
              undefined,
              stop.signal,
            );
            const draft = cited.text;
            if (!isNoAnswer(draft) && !isProseNonAnswer(draft)) {
              const numbersContext = `${query} ${searchQuestion}`;
              let answer = draft;
              let check = validateAnswer(answer, evidence, numbersContext);
              let salvaged = false;
              if (!check.ok) {
                const salvage = buildQualitativeSalvage(answer, evidence, numbersContext);
                const salvageCheck = salvage ? validateAnswer(salvage, evidence, numbersContext) : null;
                if (salvageCheck?.ok) {
                  answer = salvage;
                  check = salvageCheck;
                  salvaged = true;
                }
              }
              if (check.ok) {
                sendEvent("sources", evidence.map((item) => sourceCard(item, changes)));
                streamValidatedText(sendEvent, withoutNoAnswerToken(stripVerificationNotes(answer)));
                sendEvent("done", {
                  ok: true,
                  validated: true,
                  secondSearch: true,
                  usedQualitativeSalvage: salvaged,
                  correctedQuestion: searchPlan.corrected,
                  scopeFallback: true,
                  retrievalScope: "global",
                  bestRelevance: Number(secondRelevance.best.toFixed(3)),
                  citations: check.citations,
                  model: cited.model,
                  modelFellBack: cited.fellBack,
                  timings: {
                    expansionMs: Math.round(expansionMs),
                    retrievalMs: Math.round(retrievalMs),
                    searchPasses,
                    embeddingMs: second.timings?.embedding_ms ?? null,
                    hybridSearchMs: second.timings?.hybrid_search_ms ?? null,
                    rerankMs: second.timings?.rerank_ms ?? null,
                    hydrationMs: second.timings?.hydration_ms ?? null,
                    generationMs: Math.round(performance.now() - startedAt),
                    totalMs: Math.round(performance.now() - retrievalStartedAt),
                  },
                });
                request.log.info({ query, reason, fresh: freshPages.length }, "RAG chat: answered after a second search");
                return true;
              }
            }
          }
        } catch (error) {
          if (stop.signal.aborted) throw error;
          request.log.warn({ err: error }, "second search failed; using the general-knowledge answer");
        }

        if (reason === "no_relevant_pages") sendEvent("sources", []);
        streamValidatedText(sendEvent, body + closestDocumentsFooter(closest, responseLanguage));
        sendEvent("done", {
          ok: true,
          validated: false,
          generalKnowledge: true,
          correctedQuestion: searchPlan.corrected,
          noEvidenceReason: reason,
          scopeFallback,
          retrievalScope,
          bestRelevance: Number(relevance.best.toFixed(3)),
          citations: [],
          model: completion.model,
          modelFellBack: completion.fellBack,
          timings: {
            expansionMs: Math.round(expansionMs),
            retrievalMs: Math.round(retrievalMs),
            searchPasses,
            embeddingMs: retrieval.timings?.embedding_ms ?? null,
            hybridSearchMs: retrieval.timings?.hybrid_search_ms ?? null,
            rerankMs: retrieval.timings?.rerank_ms ?? null,
            hydrationMs: retrieval.timings?.hydration_ms ?? null,
            generationMs: Math.round(performance.now() - startedAt),
            totalMs: Math.round(performance.now() - retrievalStartedAt),
          },
        });
        request.log.info({ query, reason, closest: closest.length }, "RAG chat: general-knowledge answer");
        return true;
      } catch (error) {
        if (stop.signal.aborted) throw error;
        request.log.warn({ err: error }, "general-knowledge answer failed; sending not found");
        return false;
      }
    };

    if (retrieval.evidence.length === 0) {
      if (await answerFromGeneralKnowledge("no_relevant_pages")) return;
      sendNoEvidence("no_relevant_pages");
      return;
    }

    // A rule whose printed text was changed by a GO (ADR-094): bring in the
    // other side (printed rule, current position, archived amending GO) so the
    // answer shows both, each cited. A failure only loses the extra pages.
    let amendmentEntries = amendmentsFor(retrieval.evidence);
    if (amendmentEntries.length) {
      const extra = missingPages(amendmentEntries, retrieval.evidence);
      if (extra.length) {
        try {
          const added = await fetchPlaybookPages(searchQuestion, extra, stop.signal);
          retrieval = { ...retrieval, evidence: appendEvidence(retrieval.evidence, added.evidence) };
        } catch (error) {
          if (stop.signal.aborted) throw error;
          request.log.warn({ err: error }, "amendment pages unavailable");
        }
      }
      amendmentEntries = amendmentsFor(retrieval.evidence);
    }
    const ruleAmendments = cardAmendments(amendmentEntries, responseLanguage);
    const amendmentBlock = amendmentPrompt(amendmentEntries, retrieval.evidence, responseLanguage);

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
            searchPlan.corrected
              ? `${query}\n(The same question with typos and grammar fixed: ${searchPlan.corrected})`
              : query,
            "",
            ...(procurementSearch || usingPlaybook ? [PROCUREMENT_PROMPT, ""] : []),
            ...(usingPlaybook && playbookMatch
              ? [
                  "PLAYBOOK (how to answer this topic; checked notes, NOT evidence — cite only the pages below):",
                  `Topic: ${playbookMatch.playbook.title}`,
                  playbookMatch.playbook.guidance,
                  "",
                ]
              : []),
            ...(amendmentBlock ? [amendmentBlock, ""] : []),
            "RETRIEVED EVIDENCE:",
            evidenceContext,
          ].join("\n"),
        },
      ];


    sendEvent(
      "sources",
      retrieval.evidence.map((item) => sourceCard(item, laterChanges, ruleAmendments)),
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
          `${query} ${conversationPlan.retrievalQuery}`,
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
          LLM_REQUEST_TIMEOUT_MS,
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
    // Models also say it in prose ("The provided evidence does not contain
    // …"), with a citation to the page that does not answer; same reply.
    if (isNoAnswer(firstDraft) || isProseNonAnswer(firstDraft)) {
      // Logged so a wrong "not found" can be traced to the model or to the
      // prose detector (toy policy, 3 Oct eval).
      request.log.info(
        {
          noEvidenceReason: isNoAnswer(firstDraft) ? "model_found_no_answer" : "model_prose_non_answer",
          draftStart: firstDraft.slice(0, 300),
          evidence: retrieval.evidence.slice(0, 6).map((item) => `${item.source_id} p.${item.page_number}`),
        },
        "answer turned into not found",
      );
      const reason = isNoAnswer(firstDraft) ? "model_found_no_answer" : "model_prose_non_answer";
      if (await answerFromGeneralKnowledge(reason)) return;
      sendNoEvidence(reason, generationMs);
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
            `${query} ${conversationPlan.retrievalQuery}`,
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
            LLM_REQUEST_TIMEOUT_MS,
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
            `${query} ${conversationPlan.retrievalQuery}`,
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

      // A repair that ends in "the pages do not say" is a "not found" too.
      if (repaired && isProseNonAnswer(finalAnswer)) {
        if (await answerFromGeneralKnowledge("model_prose_non_answer")) return;
        sendNoEvidence(
          "model_prose_non_answer",
          performance.now() - generationStartedAt,
        );
        return;
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

      // No "(Note: numbers masked / verify on the original)" endings (ADR-080).
      finalAnswer =
        withoutNoAnswerToken(stripVerificationNotes(finalAnswer));

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
      searchPasses,
      expansionMs: Math.round(expansionMs),

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
        model: firstCompletion.model,
        modelFellBack: firstCompletion.fellBack,
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
          // Which model wrote it (OpenRouter or the local fallback, ADR-075).
          model: firstCompletion.model,
          modelFellBack: firstCompletion.fellBack,
          correctedQuestion: searchPlan.corrected,
          namedSourcesAdded: namedSourcesAdded.length ? namedSourcesAdded : undefined,
          procurementRulebooks: procurementSearch || undefined,
          amendments: amendmentEntries.length
            ? amendmentEntries.map((entry) => ({ id: entry.id, rule: entry.rule, reviewed: entry.reviewed }))
            : undefined,
          playbook: usingPlaybook && playbookMatch
            ? { id: playbookMatch.playbook.id, title: playbookMatch.playbook.title, reviewed: playbookMatch.playbook.reviewed }
            : undefined,
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

  // Deleted profiles past their restore window (ADR-079); never blocks start-up.
  purgeDeletedProfiles()
    .then((purged) => {
      if (purged) console.log(`Purged ${purged} deleted profile(s) past their restore window.`);
    })
    .catch((error) => console.warn("Profile purge skipped:", error instanceof Error ? error.message : error));
}

start().catch((error) => {
  server.log.error(error);
  process.exit(1);
});
