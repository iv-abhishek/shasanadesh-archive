#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f package.json ]] || [[ ! -f src/api/server.ts ]] || [[ ! -f src/rag/prompt.ts ]]; then
  echo "Run this from the shasanadesh project root."
  exit 1
fi

mkdir -p src/rag docs

cat > src/rag/answer-validation.ts <<'EOF'
import type { RetrievalEvidence } from "./types.js";

export type AnswerValidationIssueCode =
  | "empty_answer"
  | "missing_citation"
  | "invalid_citation"
  | "uncited_numeric_claim"
  | "unsafe_numeric_claim";

export interface AnswerValidationIssue {
  code: AnswerValidationIssueCode;
  message: string;
  excerpt?: string;
}

export interface AnswerValidationResult {
  ok: boolean;
  issues: AnswerValidationIssue[];
  citations: string[];
}

const CITATION_RE = /\[(S\d+)\s+p\.(\d+)\]/g;

// Government-order numerics are safety-sensitive because OCR can alter years,
// dates, amounts, percentages, rule/section numbers, levels, and identifiers.
// Devanagari digits are included as well as ASCII digits.
const NUMERIC_TOKEN_RE =
  /(?:[0-9०-९]+(?:[.,:/-][0-9०-९]+)*)/g;

const CAUTION_RE =
  /\b(?:unverified|not verified|verify|verification|ocr|source page|original page|check against|needs checking)\b|(?:असत्यापित|सत्यापन|सत्यापित नहीं|मूल पृष्ठ|मूल पेज|जाँच|जांच|पुष्टि)/i;

function citationKey(
  label: string,
  pageNumber: number,
): string {
  return `${label}:${pageNumber}`;
}

function isRiskyNumericEvidence(
  evidence: RetrievalEvidence,
): boolean {
  return (
    evidence.numeric_verification_status === "conflict" ||
    evidence.numeric_verification_status === "ocr_only_unverified" ||
    evidence.numeric_verification_status === "unverified"
  );
}

function extractCitations(
  text: string,
): Array<{
  raw: string;
  label: string;
  pageNumber: number;
}> {
  const citations: Array<{
    raw: string;
    label: string;
    pageNumber: number;
  }> = [];

  for (const match of text.matchAll(CITATION_RE)) {
    citations.push({
      raw: match[0],
      label: match[1],
      pageNumber: Number.parseInt(match[2], 10),
    });
  }

  return citations;
}

function stripCitations(text: string): string {
  return text.replace(CITATION_RE, "");
}

function claimUnits(text: string): string[] {
  return text
    .split(/(?<=[.!?।])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function validateAnswer(
  answer: string,
  evidence: RetrievalEvidence[],
): AnswerValidationResult {
  const issues: AnswerValidationIssue[] = [];
  const trimmed = answer.trim();

  if (!trimmed) {
    return {
      ok: false,
      issues: [
        {
          code: "empty_answer",
          message: "Generator returned an empty answer.",
        },
      ],
      citations: [],
    };
  }

  const evidenceByKey = new Map(
    evidence.map((item) => [
      citationKey(item.label, item.page_number),
      item,
    ]),
  );

  const citations = extractCitations(trimmed);

  if (
    evidence.length > 0 &&
    citations.length === 0
  ) {
    issues.push({
      code: "missing_citation",
      message:
        "The answer contains no source-page citation even though evidence was supplied.",
    });
  }

  for (const citation of citations) {
    const key = citationKey(
      citation.label,
      citation.pageNumber,
    );

    if (!evidenceByKey.has(key)) {
      issues.push({
        code: "invalid_citation",
        message:
          `Citation ${citation.raw} does not match any supplied evidence page.`,
        excerpt: citation.raw,
      });
    }
  }

  for (const unit of claimUnits(trimmed)) {
    const withoutCitations =
      stripCitations(unit);

    if (!NUMERIC_TOKEN_RE.test(withoutCitations)) {
      NUMERIC_TOKEN_RE.lastIndex = 0;
      continue;
    }

    NUMERIC_TOKEN_RE.lastIndex = 0;

    const unitCitations =
      extractCitations(unit);

    if (unitCitations.length === 0) {
      issues.push({
        code: "uncited_numeric_claim",
        message:
          "A numeric claim must have a source-page citation in the same sentence or line.",
        excerpt: unit.slice(0, 240),
      });

      continue;
    }

    const citedEvidence =
      unitCitations
        .map((citation) =>
          evidenceByKey.get(
            citationKey(
              citation.label,
              citation.pageNumber,
            ),
          ),
        )
        .filter(
          (
            item,
          ): item is RetrievalEvidence =>
            Boolean(item),
        );

    const hasSafeNumericSource =
      citedEvidence.some(
        (item) =>
          !isRiskyNumericEvidence(item),
      );

    const allNumericSourcesRisky =
      citedEvidence.length > 0 &&
      !hasSafeNumericSource;

    if (
      allNumericSourcesRisky &&
      !CAUTION_RE.test(unit)
    ) {
      issues.push({
        code: "unsafe_numeric_claim",
        message:
          "A numeric claim relies only on OCR-conflicted or OCR-only-unverified evidence and is stated without an explicit source-page verification warning.",
        excerpt: unit.slice(0, 240),
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    citations: citations.map(
      (citation) => citation.raw,
    ),
  };
}

export function buildAnswerRepairInstruction(
  originalAnswer: string,
  validation: AnswerValidationResult,
): string {
  const issueText = validation.issues
    .map(
      (issue, index) =>
        `${index + 1}. ${issue.code}: ${issue.message}` +
        (issue.excerpt
          ? `\n   Problem excerpt: ${issue.excerpt}`
          : ""),
    )
    .join("\n");

  return [
    "REPAIR THE DRAFT ANSWER.",
    "",
    "The draft failed deterministic citation/numeric-safety validation.",
    "Return ONLY a corrected final answer. Do not discuss the validation process.",
    "",
    "Requirements:",
    "- Keep factual claims grounded only in the supplied evidence.",
    "- Add valid inline citations in the exact form [S1 p.9].",
    "- Every numeric claim must have a citation in the same sentence or line.",
    "- If a numeric value is supported only by evidence marked conflict, ocr_only_unverified, or unverified, prefer omitting the exact value.",
    "- If such a risky numeric value must be mentioned, explicitly say it is OCR-unverified/disputed and requires checking against the cited original source page.",
    "- Never invent a replacement number.",
    "",
    "VALIDATION FAILURES:",
    issueText,
    "",
    "DRAFT ANSWER:",
    originalAnswer,
  ].join("\n");
}

export function buildConservativeFallback(
  evidence: RetrievalEvidence[],
): string {
  if (evidence.length === 0) {
    return (
      "I could not retrieve evidence sufficient to answer this question from the archived government-order corpus."
    );
  }

  const first = evidence[0];

  return [
    "Relevant government-order evidence was retrieved, but a fully generated answer did not pass the citation and numeric-verification safety checks.",
    `Please review the original source page directly [${first.label} p.${first.page_number}].`,
    "Any critical date, amount, percentage, rule number, level, Government Order number, or identifier from OCR-only or conflicting extraction should be verified against the original page before it is relied upon.",
  ].join(" ");
}
EOF

cat > src/rag/prompt.ts <<'EOF'
/**
 * Evidence-grounded generation prompt.
 *
 * Citation contract:
 *   [S1 p.9]
 *
 * Prompt rules are necessary but not sufficient. The API performs a deterministic
 * citation/numeric-safety validation pass before answer text is released.
 */

import type { RetrievalEvidence } from "./types.js";
import { deriveNumericVerificationStatus } from "./verification.js";

export const RAG_SYSTEM_PROMPT = `
You are an assistant for Uttar Pradesh government orders and administrative rules.

Use ONLY the supplied evidence for factual claims about government orders.
Do not invent missing provisions, dates, amounts, rule numbers, GO numbers, eligibility
conditions, procedures, exceptions, or supersession relationships.

CITATIONS
- Cite factual claims inline using the exact form [S1 p.9].
- S1/S2/etc. refer to the supplied evidence blocks.
- Put a citation in every substantive paragraph or bullet that relies on retrieved evidence.
- Every sentence or line containing a numeric claim must contain a supporting citation.
- Prefer citing the most directly supporting page.
- Do not cite a source that does not support the claim.
- Never invent a source label or page number.

OCR / NUMERIC VERIFICATION
- NUMERIC_CONFLICT=NO does NOT mean numbers are verified.
- NUMERIC_VERIFICATION_STATUS=conflict means extraction variants disagree on numeric
  tokens. Do NOT silently choose a disputed numeric value.
- NUMERIC_VERIFICATION_STATUS=ocr_only_unverified means OCR is the canonical/only
  usable text representation. Critical dates, amounts, percentages, rule numbers,
  levels, GO numbers, and identifiers are not authoritative until checked against the
  cited original source page.
- For conflict, ocr_only_unverified, or unverified evidence, prefer answering
  qualitatively and OMITTING exact critical numbers.
- If an exact risky number must be mentioned, clearly label it OCR-unverified/disputed
  in the SAME sentence and say it requires verification against the cited original page.
- NUMERIC_VERIFICATION_STATUS=variants_agree means native/OCR numeric tokens did not
  trigger the conflict detector. This improves extraction confidence but is not
  source-page proof.
- NUMERIC_VERIFICATION_STATUS=native_primary means native PDF text is the primary
  evidence representation. It is still not a substitute for source-page verification
  for unusually consequential or ambiguous numeric claims.
- You may use risky pages for non-disputed qualitative provisions.

ANSWER QUALITY
- Answer the user's question directly.
- Match the user's language when practical.
- If the evidence does not establish the answer, say what is not established.
- Distinguish a rule/provision from an example, appendix, form, or explanation.
- Do not treat reranker scores as confidence or legal authority.
`.trim();

function clip(
  text: string,
  maxChars = 7000,
): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n[...page text clipped...]`;
}

export function buildEvidenceContext(
  evidence: RetrievalEvidence[],
): string {
  if (evidence.length === 0) {
    return "NO EVIDENCE WAS RETRIEVED.";
  }

  return evidence
    .map((item) => {
      const verificationStatus =
        item.numeric_verification_status ??
        deriveNumericVerificationStatus(item);

      const header = [
        `SOURCE ${item.label}`,
        `SOURCE_ID=${item.source_id}`,
        `PAGE=${item.page_number}`,
        `DEPARTMENT=${item.department ?? "unknown"}`,
        `GO_NUMBER=${item.go_number ?? "unknown"}`,
        `GO_DATE=${item.go_date ?? "unknown"}`,
        `SELECTED_VARIANT=${item.selected_variant}`,
        `SELECTED_CANONICAL=${item.selected_canonical ? "YES" : "NO"}`,
        `NUMERIC_CONFLICT=${item.numeric_conflict ? "YES" : "NO"}`,
        `NUMERIC_VERIFICATION_STATUS=${verificationStatus}`,
      ].join("\n");

      const selected = [
        "SELECTED PAGE TEXT:",
        clip(item.selected_page_text),
      ].join("\n");

      const canonicalDiffers =
        item.canonical_page_text !==
        item.selected_page_text;

      const canonical = canonicalDiffers
        ? [
            "CANONICAL PAGE TEXT:",
            clip(item.canonical_page_text),
          ].join("\n")
        : "";

      return [
        header,
        selected,
        canonical,
      ]
        .filter(Boolean)
        .join("\n\n");
    })
    .join(
      "\n\n============================================================\n\n",
    );
}
EOF

cat > src/api/server.ts <<'EOF'
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
  buildAnswerRepairInstruction,
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

const LLM_TEMPERATURE = Number.parseFloat(
  process.env.LLM_TEMPERATURE ?? "0.1",
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
        "content-type":
          "application/json",
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
}

async function generateCompletion(
  openai: OpenAI,
  messages: GeneratorMessage[],
  temperature: number,
): Promise<string> {
  const completion =
    await openai.chat.completions.create({
      model: LLM_MODEL!,
      messages:
        messages as Parameters<
          typeof openai.chat.completions.create
        >[0]["messages"],
      temperature,
      max_tokens: LLM_MAX_TOKENS,
      stream: false,
    });

  return (
    completion.choices[0]
      ?.message?.content ?? ""
  ).trim();
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
          );

        const repairedValidation =
          validateAnswer(
            repairedAnswer,
            retrieval.evidence,
          );

        finalAnswer =
          repairedAnswer;

        finalValidation =
          repairedValidation;
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
          citations:
            finalValidation.citations,
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
EOF

cat > src/rag/answer-validation.test.ts <<'EOF'
import assert from "node:assert/strict";
import {
  validateAnswer,
} from "./answer-validation.js";

const base = {
  source_id: "x",
  department: "Test",
  go_number: null,
  go_date: null,
  source_url: "https://example.invalid/doc",
  page_url: "https://example.invalid/doc#page=1",
  selected_variant: "native",
  selected_canonical: true,
  numeric_conflict: false,
  selected_page_text: "example",
  canonical_page_text: "example",
  rerank_score_raw: 1,
};

const safeEvidence = [
  {
    ...base,
    label: "S1",
    page_number: 1,
    numeric_verification_status:
      "native_primary",
  },
] as any;

const riskyEvidence = [
  {
    ...base,
    label: "S1",
    page_number: 1,
    selected_variant: "ocr",
    numeric_verification_status:
      "ocr_only_unverified",
  },
] as any;

assert.equal(
  validateAnswer(
    "The rule applies to these officers [S1 p.1].",
    safeEvidence,
  ).ok,
  true,
);

assert.equal(
  validateAnswer(
    "The rule applies to these officers.",
    safeEvidence,
  ).ok,
  false,
);

assert.equal(
  validateAnswer(
    "The rule dates from 1991 [S1 p.1].",
    riskyEvidence,
  ).ok,
  false,
);

assert.equal(
  validateAnswer(
    "The OCR text appears to show 1991, but that year is unverified and requires checking against the original source page [S1 p.1].",
    riskyEvidence,
  ).ok,
  true,
);

assert.equal(
  validateAnswer(
    "The rule dates from 1991.",
    safeEvidence,
  ).ok,
  false,
);

assert.equal(
  validateAnswer(
    "The rule dates from 1991 [S1 p.1].",
    safeEvidence,
  ).ok,
  true,
);

assert.equal(
  validateAnswer(
    "The rule applies [S9 p.99].",
    safeEvidence,
  ).ok,
  false,
);

console.log(
  "answer-validation tests passed",
);
EOF

npm pkg set scripts.test:rag-validation="tsx src/rag/answer-validation.test.ts" >/dev/null

if ! grep -q "ADR-022 — Deterministic Answer Safety Gate" docs/DECISIONS.md 2>/dev/null; then
cat >> docs/DECISIONS.md <<'EOF'

## ADR-022 — Deterministic Answer Safety Gate

Prompt instructions are not sufficient for citation or OCR-numeric safety.

Before any generated answer text is released to the client, the TypeScript API now:

1. buffers the complete model draft;
2. validates citation syntax and source/page membership;
3. requires numeric claims to carry a same-sentence/source-line citation;
4. blocks uncaveated numeric claims supported only by `conflict`,
   `ocr_only_unverified`, or `unverified` evidence;
5. attempts one evidence-grounded repair;
6. falls back to a conservative source-page review message if repair still fails.

The final validated answer is then emitted over the existing SSE `token` contract in
small text chunks. This deliberately trades first-token latency for a stronger
"no unsafe token leaves the server" invariant.
EOF
fi

if [[ -f docs/RAG_SERVICE.md ]] && ! grep -q "Answer safety gate" docs/RAG_SERVICE.md; then
cat >> docs/RAG_SERVICE.md <<'EOF'

## Answer safety gate

`/api/chat` does not directly forward raw model tokens.

The API buffers a draft, validates citations and numeric evidence safety, repairs once
if necessary, and only then emits the validated final answer over SSE. This prevents a
bad citation or OCR-corrupted critical number from being streamed before the server can
detect it.
EOF
fi

echo
echo "Running deterministic validator tests..."
npm run test:rag-validation

echo
echo "Running TypeScript type-check..."
npx tsc --noEmit

echo
echo "Answer safety gate installed successfully."
echo
echo "Restart only the TypeScript API on port 8787:"
echo
echo '  PID="$(lsof -tiTCP:8787 -sTCP:LISTEN || true)"'
echo '  if [ -n "$PID" ]; then kill "$PID"; fi'
echo "  npm run api:dev:local-generator"
echo
echo "Then test:"
echo '  npm run chat:test -- "medical officer seniority"'
echo '  npm run chat:test -- "सोलर पम्प"'
