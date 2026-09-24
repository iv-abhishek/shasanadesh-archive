#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f package.json ]]; then
  echo "Run this from the shasanadesh project root."
  exit 1
fi

mkdir -p eval src/eval docs

cat > eval/rag-cases.json <<'EOF'
[
  {
    "id": "medical-officer-seniority",
    "query": "medical officer seniority",
    "language": "en",
    "expectedSourceIds": ["25#201#2#2020"],
    "expectedPagesBySource": {
      "25#201#2#2020": [18, 19, 20, 15]
    },
    "requireCitation": true,
    "allowFallback": false,
    "notes": "OCR-only medical document. Exact risky numerics should not be exposed without verification."
  },
  {
    "id": "solar-pump-hindi",
    "query": "सोलर पम्प",
    "language": "hi",
    "expectedSourceIds": ["61#37#5#2023"],
    "expectedPagesBySource": {
      "61#37#5#2023": [7, 2, 4, 5]
    },
    "requireCitation": true,
    "allowFallback": false,
    "notes": "Mixed conflict/native evidence. Qualitative salvage is acceptable; generic fallback is not."
  }
]
EOF

cat > src/eval/run-rag-eval.ts <<'EOF'
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

type Language =
  | "en"
  | "hi"
  | "mixed";

interface EvalCase {
  id: string;
  query: string;
  language?: Language;
  expectedSourceIds?: string[];
  expectedPagesBySource?: Record<
    string,
    number[]
  >;
  requireCitation?: boolean;
  allowFallback?: boolean;
  notes?: string;
}

interface SearchEvidence {
  label: string;
  source_id: string;
  page_number: number;
  numeric_verification_status?: string;
}

interface SearchResponse {
  evidence: SearchEvidence[];
}

interface ChatSource {
  label: string;
  sourceId: string;
  pageNumber: number;
  numericVerificationStatus?: string;
}

interface DoneEvent {
  ok?: boolean;
  validated?: boolean;
  repaired?: boolean;
  usedFallback?: boolean;
  usedQualitativeSalvage?: boolean;
  citations?: string[];
  firstValidationIssues?: string[];
  repairValidationIssues?: string[];
}

interface ChatResult {
  answer: string;
  sources: ChatSource[];
  done: DoneEvent | null;
  error: string | null;
  elapsedMs: number;
}

interface CaseResult {
  id: string;
  query: string;
  searchMs: number;
  chatMs: number | null;
  sourceHitAtK: boolean | null;
  pageHitAtK: boolean | null;
  sourceReciprocalRank: number | null;
  pageReciprocalRank: number | null;
  validated: boolean | null;
  repaired: boolean | null;
  usedQualitativeSalvage: boolean | null;
  usedFallback: boolean | null;
  citationCount: number | null;
  expectedCitationPageHit: boolean | null;
  internalPlaceholderLeak: boolean | null;
  firstValidationIssues: string[];
  repairValidationIssues: string[];
  answer: string | null;
  error: string | null;
  passed: boolean;
  failures: string[];
}

interface CliOptions {
  apiBase: string;
  casesPath: string;
  limit: number | null;
  onlyCase: string | null;
  searchOnly: boolean;
  topK: number;
  timeoutMs: number;
}

const CITATION_RE =
  /\[(S\d+)\s+p\.(\d+)\]/g;

const INTERNAL_PLACEHOLDER_RE =
  /UNVERIFIED_NUMERIC/i;

function parseArgs(
  argv: string[],
): CliOptions {
  const options: CliOptions = {
    apiBase:
      process.env.RAG_API_BASE_URL ??
      "http://127.0.0.1:8787",
    casesPath:
      process.env.RAG_EVAL_CASES ??
      "eval/rag-cases.json",
    limit: null,
    onlyCase: null,
    searchOnly: false,
    topK: Number.parseInt(
      process.env.RAG_EVAL_TOP_K ?? "4",
      10,
    ),
    timeoutMs: Number.parseInt(
      process.env.RAG_EVAL_TIMEOUT_MS ??
        "1200000",
      10,
    ),
  };

  for (
    let index = 0;
    index < argv.length;
    index += 1
  ) {
    const arg = argv[index];

    if (arg === "--search-only") {
      options.searchOnly = true;
      continue;
    }

    if (
      arg === "--case" &&
      argv[index + 1]
    ) {
      options.onlyCase =
        argv[index + 1];
      index += 1;
      continue;
    }

    if (
      arg === "--limit" &&
      argv[index + 1]
    ) {
      options.limit =
        Number.parseInt(
          argv[index + 1],
          10,
        );
      index += 1;
      continue;
    }

    if (
      arg === "--top-k" &&
      argv[index + 1]
    ) {
      options.topK =
        Number.parseInt(
          argv[index + 1],
          10,
        );
      index += 1;
      continue;
    }

    if (
      arg === "--api" &&
      argv[index + 1]
    ) {
      options.apiBase =
        argv[index + 1];
      index += 1;
      continue;
    }

    if (
      arg === "--cases" &&
      argv[index + 1]
    ) {
      options.casesPath =
        argv[index + 1];
      index += 1;
      continue;
    }
  }

  return options;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeoutMs,
    );

  try {
    return await fetch(
      url,
      {
        ...init,
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

function expectedPagesFor(
  testCase: EvalCase,
  sourceId: string,
): number[] {
  return (
    testCase
      .expectedPagesBySource
      ?.[sourceId] ?? []
  );
}

function matchesExpectedPage(
  testCase: EvalCase,
  sourceId: string,
  pageNumber: number,
): boolean {
  return expectedPagesFor(
    testCase,
    sourceId,
  ).includes(pageNumber);
}

function reciprocalRank(
  hits: boolean[],
): number | null {
  const index =
    hits.findIndex(Boolean);

  if (index < 0) {
    return 0;
  }

  return 1 / (index + 1);
}

async function runSearch(
  testCase: EvalCase,
  options: CliOptions,
): Promise<{
  response: SearchResponse;
  elapsedMs: number;
}> {
  const started =
    performance.now();

  const response =
    await fetchWithTimeout(
      `${options.apiBase}/api/search`,
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json",
        },
        body: JSON.stringify({
          query:
            testCase.query,
          topK:
            options.topK,
        }),
      },
      options.timeoutMs,
    );

  const elapsedMs =
    performance.now() - started;

  if (!response.ok) {
    throw new Error(
      `Search returned ${response.status}: ${await response.text()}`,
    );
  }

  return {
    response:
      (await response.json()) as
        SearchResponse,
    elapsedMs,
  };
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
    const rawLine of block.split(/\r?\n/)
  ) {
    if (
      rawLine.startsWith(
        "event:",
      )
    ) {
      event =
        rawLine
          .slice("event:".length)
          .trim();

      continue;
    }

    if (
      rawLine.startsWith(
        "data:",
      )
    ) {
      dataLines.push(
        rawLine
          .slice("data:".length)
          .trimStart(),
      );
    }
  }

  if (!event) {
    return null;
  }

  const rawData =
    dataLines.join("\n");

  let data: unknown =
    rawData;

  if (rawData) {
    try {
      data =
        JSON.parse(rawData);
    } catch {
      // Keep raw text for diagnostics.
    }
  }

  return {
    event,
    data,
  };
}

async function runChat(
  testCase: EvalCase,
  options: CliOptions,
): Promise<ChatResult> {
  const started =
    performance.now();

  const response =
    await fetchWithTimeout(
      `${options.apiBase}/api/chat`,
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
                testCase.query,
            },
          ],
        }),
      },
      options.timeoutMs,
    );

  if (!response.ok) {
    throw new Error(
      `Chat returned ${response.status}: ${await response.text()}`,
    );
  }

  if (!response.body) {
    throw new Error(
      "Chat response has no body.",
    );
  }

  const reader =
    response.body.getReader();

  const decoder =
    new TextDecoder();

  let buffer = "";
  let answer = "";
  let sources: ChatSource[] = [];
  let done: DoneEvent | null =
    null;
  let error: string | null =
    null;

  const processBlock = (
    block: string,
  ) => {
    const parsed =
      parseSseBlock(block);

    if (!parsed) {
      return;
    }

    if (
      parsed.event === "sources" &&
      Array.isArray(parsed.data)
    ) {
      sources =
        parsed.data as ChatSource[];
      return;
    }

    if (
      parsed.event === "token" &&
      parsed.data &&
      typeof parsed.data ===
        "object"
    ) {
      const text =
        (parsed.data as {
          text?: unknown;
        }).text;

      if (
        typeof text ===
        "string"
      ) {
        answer += text;
      }

      return;
    }

    if (
      parsed.event === "done" &&
      parsed.data &&
      typeof parsed.data ===
        "object"
    ) {
      done =
        parsed.data as
          DoneEvent;
      return;
    }

    if (
      parsed.event === "error"
    ) {
      if (
        parsed.data &&
        typeof parsed.data ===
          "object"
      ) {
        const message =
          (parsed.data as {
            message?: unknown;
          }).message;

        error =
          typeof message ===
            "string"
            ? message
            : JSON.stringify(
                parsed.data,
              );
      } else {
        error =
          String(parsed.data);
      }
    }
  };

  while (true) {
    const {
      value,
      done: streamDone,
    } = await reader.read();

    if (streamDone) {
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
      blocks.pop() ?? "";

    for (const block of blocks) {
      processBlock(block);
    }
  }

  buffer +=
    decoder.decode();

  if (buffer.trim()) {
    processBlock(buffer);
  }

  return {
    answer:
      answer.trim(),
    sources,
    done,
    error,
    elapsedMs:
      performance.now() -
      started,
  };
}

function citationLocations(
  answer: string,
  sources: ChatSource[],
): Array<{
  label: string;
  pageNumber: number;
  sourceId: string | null;
}> {
  const sourceByLabel =
    new Map(
      sources.map(
        (source) => [
          source.label,
          source,
        ],
      ),
    );

  const citations: Array<{
    label: string;
    pageNumber: number;
    sourceId: string | null;
  }> = [];

  for (
    const match of
      answer.matchAll(
        CITATION_RE,
      )
  ) {
    const label =
      match[1];

    const pageNumber =
      Number.parseInt(
        match[2],
        10,
      );

    citations.push({
      label,
      pageNumber,
      sourceId:
        sourceByLabel.get(label)
          ?.sourceId ??
        null,
    });
  }

  return citations;
}

async function evaluateCase(
  testCase: EvalCase,
  options: CliOptions,
): Promise<CaseResult> {
  const failures: string[] = [];

  const {
    response: search,
    elapsedMs: searchMs,
  } = await runSearch(
    testCase,
    options,
  );

  const expectedSourceIds =
    testCase.expectedSourceIds ??
    [];

  const hasSourceExpectation =
    expectedSourceIds.length > 0;

  const sourceHits =
    search.evidence.map(
      (item) =>
        expectedSourceIds.includes(
          item.source_id,
        ),
    );

  const sourceHitAtK =
    hasSourceExpectation
      ? sourceHits.some(Boolean)
      : null;

  const sourceReciprocalRank =
    hasSourceExpectation
      ? reciprocalRank(
          sourceHits,
        )
      : null;

  const hasPageExpectation =
    Boolean(
      testCase
        .expectedPagesBySource &&
      Object.keys(
        testCase
          .expectedPagesBySource,
      ).length > 0,
    );

  const pageHits =
    search.evidence.map(
      (item) =>
        matchesExpectedPage(
          testCase,
          item.source_id,
          item.page_number,
        ),
    );

  const pageHitAtK =
    hasPageExpectation
      ? pageHits.some(Boolean)
      : null;

  const pageReciprocalRank =
    hasPageExpectation
      ? reciprocalRank(
          pageHits,
        )
      : null;

  if (
    sourceHitAtK === false
  ) {
    failures.push(
      "expected source not retrieved",
    );
  }

  if (
    pageHitAtK === false
  ) {
    failures.push(
      "expected source/page not retrieved",
    );
  }

  if (
    options.searchOnly
  ) {
    return {
      id:
        testCase.id,
      query:
        testCase.query,
      searchMs,
      chatMs: null,
      sourceHitAtK,
      pageHitAtK,
      sourceReciprocalRank,
      pageReciprocalRank,
      validated: null,
      repaired: null,
      usedQualitativeSalvage:
        null,
      usedFallback: null,
      citationCount: null,
      expectedCitationPageHit:
        null,
      internalPlaceholderLeak:
        null,
      firstValidationIssues: [],
      repairValidationIssues: [],
      answer: null,
      error: null,
      passed:
        failures.length === 0,
      failures,
    };
  }

  const chat =
    await runChat(
      testCase,
      options,
    );

  if (chat.error) {
    failures.push(
      `chat error: ${chat.error}`,
    );
  }

  if (!chat.done) {
    failures.push(
      "missing done event",
    );
  }

  const validated =
    chat.done?.validated ??
    null;

  if (validated !== true) {
    failures.push(
      "answer was not validated",
    );
  }

  const usedFallback =
    chat.done?.usedFallback ??
    null;

  if (
    testCase.allowFallback ===
      false &&
    usedFallback === true
  ) {
    failures.push(
      "generic fallback was used",
    );
  }

  const citations =
    citationLocations(
      chat.answer,
      chat.sources,
    );

  if (
    testCase.requireCitation &&
    citations.length === 0
  ) {
    failures.push(
      "required citation missing",
    );
  }

  const expectedCitationPageHit =
    hasPageExpectation
      ? citations.some(
          (citation) =>
            citation.sourceId !==
              null &&
            matchesExpectedPage(
              testCase,
              citation.sourceId,
              citation.pageNumber,
            ),
        )
      : null;

  if (
    testCase.requireCitation &&
    hasPageExpectation &&
    expectedCitationPageHit ===
      false
  ) {
    failures.push(
      "answer did not cite an expected source/page",
    );
  }

  const internalPlaceholderLeak =
    INTERNAL_PLACEHOLDER_RE.test(
      chat.answer,
    );

  if (
    internalPlaceholderLeak
  ) {
    failures.push(
      "internal numeric placeholder leaked",
    );
  }

  return {
    id:
      testCase.id,
    query:
      testCase.query,
    searchMs,
    chatMs:
      chat.elapsedMs,
    sourceHitAtK,
    pageHitAtK,
    sourceReciprocalRank,
    pageReciprocalRank,
    validated,
    repaired:
      chat.done?.repaired ??
      null,
    usedQualitativeSalvage:
      chat.done
        ?.usedQualitativeSalvage ??
      null,
    usedFallback,
    citationCount:
      citations.length,
    expectedCitationPageHit,
    internalPlaceholderLeak,
    firstValidationIssues:
      chat.done
        ?.firstValidationIssues ??
      [],
    repairValidationIssues:
      chat.done
        ?.repairValidationIssues ??
      [],
    answer:
      chat.answer,
    error:
      chat.error,
    passed:
      failures.length === 0,
    failures,
  };
}

function mean(
  values: number[],
): number | null {
  if (values.length === 0) {
    return null;
  }

  return (
    values.reduce(
      (sum, value) =>
        sum + value,
      0,
    ) / values.length
  );
}

function median(
  values: number[],
): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted =
    [...values].sort(
      (a, b) => a - b,
    );

  const middle =
    Math.floor(
      sorted.length / 2,
    );

  if (
    sorted.length % 2 === 0
  ) {
    return (
      sorted[middle - 1] +
      sorted[middle]
    ) / 2;
  }

  return sorted[middle];
}

function rate(
  values: Array<
    boolean | null
  >,
): number | null {
  const concrete =
    values.filter(
      (
        value,
      ): value is boolean =>
        value !== null,
    );

  if (
    concrete.length === 0
  ) {
    return null;
  }

  return (
    concrete.filter(Boolean)
      .length /
    concrete.length
  );
}

function pct(
  value: number | null,
): string {
  return value === null
    ? "-"
    : `${(
        value * 100
      ).toFixed(1)}%`;
}

function ms(
  value: number | null,
): string {
  return value === null
    ? "-"
    : `${Math.round(value)} ms`;
}

function buildSummary(
  results: CaseResult[],
) {
  return {
    cases:
      results.length,
    passed:
      results.filter(
        (item) => item.passed,
      ).length,
    passRate:
      rate(
        results.map(
          (item) =>
            item.passed,
        ),
      ),
    sourceHitAtK:
      rate(
        results.map(
          (item) =>
            item.sourceHitAtK,
        ),
      ),
    pageHitAtK:
      rate(
        results.map(
          (item) =>
            item.pageHitAtK,
        ),
      ),
    sourceMRR:
      mean(
        results
          .map(
            (item) =>
              item
                .sourceReciprocalRank,
          )
          .filter(
            (
              value,
            ): value is number =>
              value !== null,
          ),
      ),
    pageMRR:
      mean(
        results
          .map(
            (item) =>
              item
                .pageReciprocalRank,
          )
          .filter(
            (
              value,
            ): value is number =>
              value !== null,
          ),
      ),
    validatedRate:
      rate(
        results.map(
          (item) =>
            item.validated,
        ),
      ),
    repairRate:
      rate(
        results.map(
          (item) =>
            item.repaired,
        ),
      ),
    salvageRate:
      rate(
        results.map(
          (item) =>
            item
              .usedQualitativeSalvage,
        ),
      ),
    fallbackRate:
      rate(
        results.map(
          (item) =>
            item.usedFallback,
        ),
      ),
    expectedCitationPageHitRate:
      rate(
        results.map(
          (item) =>
            item
              .expectedCitationPageHit,
        ),
      ),
    placeholderLeakRate:
      rate(
        results.map(
          (item) =>
            item
              .internalPlaceholderLeak,
        ),
      ),
    medianSearchMs:
      median(
        results.map(
          (item) =>
            item.searchMs,
        ),
      ),
    medianChatMs:
      median(
        results
          .map(
            (item) =>
              item.chatMs,
          )
          .filter(
            (
              value,
            ): value is number =>
              value !== null,
          ),
      ),
  };
}

function markdownReport(
  runAt: string,
  options: CliOptions,
  results: CaseResult[],
  summary:
    ReturnType<
      typeof buildSummary
    >,
): string {
  const lines = [
    "# RAG Evaluation Report",
    "",
    `Run: ${runAt}`,
    `API: ${options.apiBase}`,
    `Top K: ${options.topK}`,
    `Mode: ${options.searchOnly ? "search-only" : "search + chat"}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Cases | ${summary.cases} |`,
    `| Pass rate | ${pct(summary.passRate)} |`,
    `| Source Hit@K | ${pct(summary.sourceHitAtK)} |`,
    `| Page Hit@K | ${pct(summary.pageHitAtK)} |`,
    `| Source MRR | ${summary.sourceMRR?.toFixed(3) ?? "-"} |`,
    `| Page MRR | ${summary.pageMRR?.toFixed(3) ?? "-"} |`,
    `| Validated | ${pct(summary.validatedRate)} |`,
    `| Repair rate | ${pct(summary.repairRate)} |`,
    `| Qualitative salvage rate | ${pct(summary.salvageRate)} |`,
    `| Generic fallback rate | ${pct(summary.fallbackRate)} |`,
    `| Expected citation-page hit | ${pct(summary.expectedCitationPageHitRate)} |`,
    `| Internal placeholder leak | ${pct(summary.placeholderLeakRate)} |`,
    `| Median search latency | ${ms(summary.medianSearchMs)} |`,
    `| Median chat latency | ${ms(summary.medianChatMs)} |`,
    "",
    "## Cases",
    "",
    "| Case | Pass | Source | Page | Validated | Salvage | Fallback | Chat latency |",
    "| --- | --- | --- | --- | --- | --- | --- | ---: |",
  ];

  for (const result of results) {
    lines.push(
      `| ${result.id} | ${result.passed ? "PASS" : "FAIL"} | ${result.sourceHitAtK === null ? "-" : result.sourceHitAtK ? "yes" : "no"} | ${result.pageHitAtK === null ? "-" : result.pageHitAtK ? "yes" : "no"} | ${result.validated === null ? "-" : result.validated ? "yes" : "no"} | ${result.usedQualitativeSalvage === null ? "-" : result.usedQualitativeSalvage ? "yes" : "no"} | ${result.usedFallback === null ? "-" : result.usedFallback ? "yes" : "no"} | ${ms(result.chatMs)} |`,
    );
  }

  lines.push("");

  const failed =
    results.filter(
      (item) =>
        !item.passed,
    );

  if (failed.length > 0) {
    lines.push(
      "## Failures",
      "",
    );

    for (const result of failed) {
      lines.push(
        `### ${result.id}`,
        "",
        ...result.failures.map(
          (failure) =>
            `- ${failure}`,
        ),
        "",
      );
    }
  }

  return lines.join("\n");
}

async function main():
  Promise<void> {
  const options =
    parseArgs(
      process.argv.slice(2),
    );

  const health =
    await fetch(
      `${options.apiBase}/health`,
    );

  if (!health.ok) {
    throw new Error(
      `API health failed: ${health.status}`,
    );
  }

  const rawCases =
    JSON.parse(
      await readFile(
        options.casesPath,
        "utf8",
      ),
    ) as EvalCase[];

  let cases =
    rawCases;

  if (options.onlyCase) {
    cases =
      cases.filter(
        (item) =>
          item.id ===
          options.onlyCase,
      );
  }

  if (
    options.limit !== null
  ) {
    cases =
      cases.slice(
        0,
        options.limit,
      );
  }

  if (
    cases.length === 0
  ) {
    throw new Error(
      "No evaluation cases selected.",
    );
  }

  console.log(
    `RAG evaluation: ${cases.length} case(s), ${options.searchOnly ? "search-only" : "search + chat"}`,
  );

  console.log(
    `API: ${options.apiBase}`,
  );

  console.log(
    "Local execution is intentionally sequential to protect the shared Apple GPU.",
  );

  const results:
    CaseResult[] = [];

  for (
    let index = 0;
    index < cases.length;
    index += 1
  ) {
    const testCase =
      cases[index];

    console.log(
      `\n[${index + 1}/${cases.length}] ${testCase.id}`,
    );

    console.log(
      `  query: ${testCase.query}`,
    );

    try {
      const result =
        await evaluateCase(
          testCase,
          options,
        );

      results.push(result);

      console.log(
        `  ${result.passed ? "PASS" : "FAIL"} | search=${ms(result.searchMs)} | chat=${ms(result.chatMs)}`,
      );

      if (
        result.failures
          .length > 0
      ) {
        for (
          const failure of
            result.failures
        ) {
          console.log(
            `  - ${failure}`,
          );
        }
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      results.push({
        id:
          testCase.id,
        query:
          testCase.query,
        searchMs: 0,
        chatMs: null,
        sourceHitAtK: null,
        pageHitAtK: null,
        sourceReciprocalRank:
          null,
        pageReciprocalRank:
          null,
        validated: null,
        repaired: null,
        usedQualitativeSalvage:
          null,
        usedFallback: null,
        citationCount: null,
        expectedCitationPageHit:
          null,
        internalPlaceholderLeak:
          null,
        firstValidationIssues: [],
        repairValidationIssues: [],
        answer: null,
        error:
          message,
        passed: false,
        failures: [
          message,
        ],
      });

      console.log(
        `  FAIL | ${message}`,
      );
    }
  }

  const summary =
    buildSummary(results);

  console.log(
    "\n==============================",
  );

  console.log(
    "RAG evaluation summary",
  );

  console.log(
    "==============================",
  );

  console.log(
    `Cases:                  ${summary.cases}`,
  );

  console.log(
    `Pass rate:              ${pct(summary.passRate)}`,
  );

  console.log(
    `Source Hit@${options.topK}:           ${pct(summary.sourceHitAtK)}`,
  );

  console.log(
    `Page Hit@${options.topK}:             ${pct(summary.pageHitAtK)}`,
  );

  console.log(
    `Source MRR:             ${summary.sourceMRR?.toFixed(3) ?? "-"}`,
  );

  console.log(
    `Page MRR:               ${summary.pageMRR?.toFixed(3) ?? "-"}`,
  );

  if (
    !options.searchOnly
  ) {
    console.log(
      `Validated:              ${pct(summary.validatedRate)}`,
    );

    console.log(
      `Repair rate:            ${pct(summary.repairRate)}`,
    );

    console.log(
      `Salvage rate:           ${pct(summary.salvageRate)}`,
    );

    console.log(
      `Fallback rate:          ${pct(summary.fallbackRate)}`,
    );

    console.log(
      `Expected citation page: ${pct(summary.expectedCitationPageHitRate)}`,
    );

    console.log(
      `Placeholder leaks:      ${pct(summary.placeholderLeakRate)}`,
    );
  }

  console.log(
    `Median search:          ${ms(summary.medianSearchMs)}`,
  );

  if (
    !options.searchOnly
  ) {
    console.log(
      `Median chat:            ${ms(summary.medianChatMs)}`,
    );
  }

  const runAt =
    new Date().toISOString();

  const safeStamp =
    runAt.replace(
      /[:.]/g,
      "-",
    );

  const outputDir =
    path.join(
      "data",
      "eval",
      "runs",
    );

  await mkdir(
    outputDir,
    {
      recursive: true,
    },
  );

  const jsonPath =
    path.join(
      outputDir,
      `${safeStamp}.json`,
    );

  const mdPath =
    path.join(
      outputDir,
      `${safeStamp}.md`,
    );

  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        runAt,
        options,
        summary,
        results,
      },
      null,
      2,
    ) + "\n",
  );

  await writeFile(
    mdPath,
    markdownReport(
      runAt,
      options,
      results,
      summary,
    ) + "\n",
  );

  console.log(
    `\nJSON report: ${jsonPath}`,
  );

  console.log(
    `Markdown report: ${mdPath}`,
  );

  if (
    results.some(
      (item) =>
        !item.passed,
    )
  ) {
    process.exitCode = 1;
  }
}

main().catch(
  (error) => {
    console.error(
      error instanceof Error
        ? error.stack
        : error,
    );

    process.exit(1);
  },
);
EOF

npm pkg set scripts.eval:rag="tsx src/eval/run-rag-eval.ts" >/dev/null
npm pkg set scripts.eval:rag:search="tsx src/eval/run-rag-eval.ts --search-only" >/dev/null

cat > docs/EVALUATION.md <<'EOF'
# RAG Evaluation

The project uses a fixed, version-controlled evaluation set so retrieval and answer
changes are measured rather than judged from one or two manual queries.

## Case file

`eval/rag-cases.json`

Each case may define:

- `id`
- `query`
- `language`
- `expectedSourceIds`
- `expectedPagesBySource`
- `requireCitation`
- `allowFallback`
- `notes`

Only add expected source/page labels after they have been verified against the corpus.
Do not invent expected pages simply to increase the benchmark size.

## Metrics

The harness records:

- source Hit@K
- page Hit@K
- source MRR
- page MRR
- deterministic answer validation rate
- repair rate
- qualitative salvage rate
- generic fallback rate
- expected citation-page hit rate
- internal numeric-placeholder leak rate
- search latency
- chat latency

The local benchmark runs sequentially because retrieval/reranking and MLX generation
share the Apple GPU.

## Commands

Fast retrieval-only baseline:

```bash
npm run eval:rag:search
```

Full search + answer evaluation:

```bash
npm run eval:rag
```

One case:

```bash
npm run eval:rag -- --case medical-officer-seniority
```

Limit the run:

```bash
npm run eval:rag -- --limit 2
```

Override the API or top K:

```bash
npm run eval:rag -- --api http://127.0.0.1:8787 --top-k 4
```

Reports are written to:

`data/eval/runs/<timestamp>.json`

and:

`data/eval/runs/<timestamp>.md`

## Expansion plan

The first two cases are verified smoke cases already exercised manually. Expand toward
30-50 cases only from verified corpus evidence, covering Hindi/English, OCR-only pages,
native pages, numeric conflicts, exact-order lookup, policy concepts, dates, amounts,
percentages, rule/section identifiers, no-evidence cases, and citation-placement cases.

Once the set is large enough, freeze a baseline and require measurable improvement or
no regression for retrieval and safety changes.
EOF

if ! grep -q "ADR-029" docs/DECISIONS.md 2>/dev/null; then
cat >> docs/DECISIONS.md <<'EOF'

## ADR-029 - Versioned RAG evaluation before frontend tuning

RAG quality changes are evaluated against a fixed, version-controlled case set rather
than individual manual prompts.

The evaluator measures retrieval source/page hits, reciprocal rank, validated-answer
rate, repair/salvage/fallback behavior, citation-page alignment, placeholder leakage,
and latency. Local runs are sequential to preserve the shared Apple GPU stability
invariant.

Expected source/page labels must be verified from the corpus before they are added to
the benchmark.
EOF
fi

echo
echo "Type-checking evaluation harness..."
npx tsc --noEmit

echo
echo "Evaluation harness installed."
echo
echo "Fast first run:"
echo "  npm run eval:rag:search"
echo
echo "Then full two-case baseline:"
echo "  npm run eval:rag"
