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
import Fastify from "fastify";
import OpenAI from "openai";
import { z } from "zod";
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

const LLM_MAX_TOKENS = Number.parseInt(
  process.env.LLM_MAX_TOKENS ?? "900",
  10,
);

const LLM_REPAIR_MAX_TOKENS = Number.parseInt(
  process.env.LLM_REPAIR_MAX_TOKENS ?? "450",
  10,
);

const LLM_TEMPERATURE = Number.parseFloat(
  process.env.LLM_TEMPERATURE ?? "0.1",
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

server.register(cors, {
  origin: true,
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
});

const SearchFiltersSchema = z.object({
  department: z
    .string()
    .trim()
    .min(1)
    .max(200)
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
    .max(12)
    .optional(),
  filters:
    SearchFiltersSchema.optional(),
});

async function retrieve(
  query: string,
  topK = RAG_TOP_K,
  filters?: SearchFilters,
): Promise<RetrievalResponse> {
  return runLocalGpuExclusive(
    "retrieval",
    async () => {
      const response = await fetch(
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
            rerank_count: 24,
            filters: {
              department:
                filters?.department,
              go_number:
                filters?.goNumber,
              source_id:
                filters?.sourceId,
              date_from:
                filters?.dateFrom,
              date_to:
                filters?.dateTo,
              verification_status:
                filters?.verificationStatus,
            },
          }),
        },
      );

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
): Promise<string> {
  return runLocalGpuExclusive(
    "generation",
    async () => {
      const upstream =
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

      let answer = "";

      for await (const chunk of upstream) {
        const token =
          chunk.choices[0]
            ?.delta?.content;

        if (token) {
          answer += token;
        }
      }

      return answer.trim();
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

    const query =
      messages[lastUserIndex]
        .content;

    const retrieval =
      await retrieve(query);

    const evidenceContext =
      buildEvidenceContext(
        retrieval.evidence,
      );

    const priorMessages =
      messages
        .slice(
          0,
          lastUserIndex,
        )
        .slice(-8)
        .map((message) => ({
          role: message.role,
          content:
            message.content,
        }));

    const generatorMessages:
      GeneratorMessage[] = [
        {
          role: "system",
          content:
            RAG_SYSTEM_PROMPT,
        },
        ...priorMessages,
        {
          role: "user",
          content: [
            "USER QUESTION:",
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

    sendEvent(
      "sources",
      retrieval.evidence.map(
        (item) => ({
          label:
            item.label,
          sourceId:
            item.source_id,
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
        }),
      ),
    );

    try {
      const firstDraft =
        await generateCompletion(
          openai,
          generatorMessages,
          LLM_TEMPERATURE,
        );

      const firstValidation =
        validateAnswer(
          firstDraft,
          retrieval.evidence,
        );

      let finalAnswer =
        firstDraft;

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

      if (!firstValidation.ok) {
        repaired = true;

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

        const repairedAnswer =
          await generateCompletion(
            openai,
            repairMessages,
            0,
            LLM_REPAIR_MAX_TOKENS,
          );

        const repairedValidation =
          validateAnswer(
            repairedAnswer,
            retrieval.evidence,
          );

        repairValidationIssues =
          repairedValidation.issues.map(
            (issue) => issue.code,
          );

        finalAnswer =
          repairedAnswer;

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
            validateAnswer(
              qualitativeSalvage,
              retrieval.evidence,
            );

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
          );

        finalValidation =
          validateAnswer(
            finalAnswer,
            retrieval.evidence,
          );
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

      sendEvent(
        "done",
        {
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
