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

function describeScope(
  scope: string,
  filters: SearchFilters | undefined,
  language: "en" | "hi",
): string {
  const hi = language === "hi";

  if (filters?.sourceId) {
    return hi ? `आदेश ${filters.sourceId}` : `order ${filters.sourceId}`;
  }

  if (filters?.department) {
    return filters.department;
  }

  if (filters?.departments?.length) {
    const names = filters.departments;
    const shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? (hi ? ` और ${names.length - 3} अन्य` : ` and ${names.length - 3} more`) : "";
    return shown + more;
  }

  return hi
    ? "सभी विभागों"
    : "all departments";
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
      let response: Response;

      try {
        response = await fetch(
        `${RETRIEVAL_BASE_URL}/search`,
        {
          method: "POST",
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
): Promise<{ text: string; truncated: boolean }> {
  return runLocalGpuExclusive(
    "generation",
    async () => {
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
          });
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
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }

      // Stopped by max_tokens: cut back to the last complete sentence/bullet
      // rather than returning a half word (src/rag/truncation.ts).
      if (finishReason === "length") {
        const trimmed = trimIncompleteAnswer(answer);
        return { text: trimmed || answer.trim(), truncated: true };
      }

      return { text: answer.trim(), truncated: false };
    },
  );
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

    const explicitSourceId =
      extractExplicitSourceId(
        query,
      );

    const explicitDepartment =
      findExplicitDepartment(
        query,
        knownDepartments,
      );

    const globalScopeRequested =
      requestsGlobalScope(
        query,
      );

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

    const sendEvent = (
      event: string,
      data: unknown,
    ) => {
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

    const evidenceContext =
      buildEvidenceContext(
        retrieval.evidence,
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
          sourceUrl:
            item.source_url,
          pageUrl:
            item.page_url,
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

    const firstCompletion =
        await generateCompletion(
          openai,
          generatorMessages,
          parsed.data.regenerate
            ? REGENERATE_TEMPERATURE
            : LLM_TEMPERATURE,
          tokenBudget,
        );

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
      reply.raw.end();
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
