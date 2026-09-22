/**
 * Shasanadesh RAG API.
 *
 * Node/TypeScript owns orchestration, evidence safety classification,
 * generator calls, and streaming.
 *
 * Python owns local embedding/reranking.
 * Generation uses any OpenAI-compatible endpoint.
 *
 * This file avoids top-level await because the current project compiles as
 * CommonJS.
 */

import cors from "@fastify/cors";
import Fastify from "fastify";
import OpenAI from "openai";
import { z } from "zod";
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
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
      }),
    )
    .min(1),
});

const SearchBodySchema = z.object({
  query: z.string().min(1),
  topK: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional(),
});

async function retrieve(
  query: string,
  topK = RAG_TOP_K,
): Promise<RetrievalResponse> {
  const response = await fetch(
    `${RETRIEVAL_BASE_URL}/search`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        top_k: topK,
        candidate_count: 50,
        rerank_count: 24,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Retrieval service returned ${response.status}: ${body}`,
    );
  }

  const raw =
    (await response.json()) as RetrievalResponse;

  return enrichRetrievalResponse(raw);
}

server.get("/health", async () => {
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
      Boolean(LLM_BASE_URL && LLM_MODEL),
    llmBaseUrl:
      LLM_BASE_URL ?? null,
    llmModel:
      LLM_MODEL ?? null,
  };
});

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
      parsed.data.messages as ChatMessage[];

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

    const generatorMessages = [
      {
        role: "system" as const,
        content:
          RAG_SYSTEM_PROMPT,
      },
      ...priorMessages,
      {
        role: "user" as const,
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
      });

    const stream =
      await openai.chat.completions.create({
        model:
          LLM_MODEL,
        messages:
          generatorMessages,
        temperature:
          0.1,
        stream:
          true,
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
      for await (
        const chunk of stream
      ) {
        const token =
          chunk.choices[0]
            ?.delta?.content;

        if (token) {
          sendEvent(
            "token",
            {
              text: token,
            },
          );
        }
      }

      sendEvent(
        "done",
        {
          ok: true,
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

async function start(): Promise<void> {
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
