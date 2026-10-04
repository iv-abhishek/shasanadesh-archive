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
  /** Free label for grouping in the report (e.g. "guideline", "not-found"). */
  category?: string;
  /**
   * Ask as an officer whose profile has these departments (default scope
   * "my_departments"). A development profile is created once and reused.
   */
  profileDepartments?: string[];
  /** The archive has no order for this: Ask must answer "no matching order". */
  expectNoEvidence?: boolean;
  /** The answer must come from outside the profile's departments (ADR-047). */
  expectScopeFallback?: boolean;
  /** At least one of these words must appear in the answer. */
  expectedTextIncludesAny?: string[];
  /** Must be answered from the order list, newest first (ADR-057). */
  expectListing?: boolean;
  /**
   * Two-turn case: ask this first, then send `query` as the suggested
   * follow-up the user clicked under that answer (followUp + the answer's
   * cited orders, as the web app does).
   */
  previousQuery?: string;
  /** The follow-up may only cite or show the orders the previous answer cited. */
  expectOnlyPreviousSources?: boolean;
  /** Any of these source IDs must be cited/shown (checked on the chat answer, not search). */
  expectedChatSourceIdsAny?: string[];
  /** None of these providers may appear among the shown sources (e.g. "core-rules"). */
  forbiddenSourcePrefixes?: string[];
  /**
   * A rule question: the answer must cite a rulebook or a generally applicable
   * order (AUTHORITY RULEBOOK or GENERAL), not only specific orders (ADR-078).
   */
  expectGeneralSource?: boolean;
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
  /** RULEBOOK / GENERAL / CONTEXT / SPECIFIC (ADR-078); null when unclassified. */
  authority?: string | null;
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
  firstValidationExcerpts?: string[];
  citationsAdded?: number;
  repairValidationIssues?: string[];
  noEvidence?: boolean;
  /** no_relevant_pages | model_found_no_answer | model_prose_non_answer */
  noEvidenceReason?: string;
  generalKnowledge?: boolean;
  shortened?: boolean;
  scopeFallback?: boolean;
  bestRelevance?: number;
  conversational?: boolean;
  /** Which model wrote the answer, and whether the primary failed first (ADR-075). */
  model?: string;
  usage?: { calls: number; promptTokens: number; completionTokens: number; costUsd: number };
  modelFellBack?: boolean;
}

interface ChatResult {
  /** Two-turn cases: the orders the first answer cited. */
  previousSourceIds?: string[];
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
  /** Kinds of document the answer cited (RULEBOOK, GENERAL, CONTEXT, SPECIFIC). */
  citedAuthorities?: string[];
  model?: string;
  usage?: { calls: number; promptTokens: number; completionTokens: number; costUsd: number };
  modelFellBack?: boolean;
  citationCount: number | null;
  expectedCitationPageHit: boolean | null;
  internalPlaceholderLeak: boolean | null;
  firstValidationIssues: string[];
  firstValidationExcerpts?: string[];
  citationsAdded?: number;
  repairValidationIssues: string[];
  answer: string | null;
  error: string | null;
  passed: boolean;
  failures: string[];
  category?: string;
  expectNoEvidence?: boolean;
  expectGeneralSource?: boolean;
  noEvidence?: boolean | null;
  noEvidenceReason?: string;
  generalKnowledge?: boolean;
  shortened?: boolean | null;
  scopeFallback?: boolean | null;
  bestRelevance?: number | null;
}

interface CliOptions {
  apiBase: string;
  casesPath: string;
  limit: number | null;
  onlyCase: string | null;
  searchOnly: boolean;
  topK: number;
  timeoutMs: number;
  /** Answer model for every question (needs RAG_ALLOW_MODEL_OVERRIDE=1 on the API; ADR-100). */
  model: string | null;
  /** Report file name prefix instead of the timestamp alone. */
  label: string | null;
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
    model: null,
    label: null,
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

    if (arg === "--model" && argv[index + 1]) {
      options.model = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--label" && argv[index + 1]) {
      options.label = argv[index + 1].replace(/[^a-z0-9._-]+/gi, "-");
      index += 1;
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

/**
 * Development profiles for cases that set profileDepartments, cached in
 * data/eval/eval-users.json so repeated runs do not create new users.
 * Only works against a non-production API (NODE_ENV !== "production").
 */
const EVAL_USERS_PATH = path.resolve("data/eval/eval-users.json");
let evalUsers: Record<string, string> | null = null;

async function evalUserFor(
  departments: string[],
  options: CliOptions,
): Promise<string> {
  const key = departments.join(" | ");
  if (evalUsers === null) {
    evalUsers = await readFile(EVAL_USERS_PATH, "utf8")
      .then((text) => JSON.parse(text) as Record<string, string>)
      .catch(() => ({}));
  }

  const cached = evalUsers[key];
  if (cached) {
    // The profile route needs a signed-in session; the development list does
    // not. (Checking the profile route failed every time, so each run made a
    // new test profile until the 5-profile limit refused them.)
    const list = await fetch(`${options.apiBase}/api/session/dev-users`)
      .then((response) => (response.ok ? (response.json() as Promise<{ profiles?: Array<{ id: string }> }>) : null))
      .catch(() => null);
    if (!list || list.profiles?.some((profile) => profile.id === cached)) return cached;
  }

  const [primary, ...additional] = departments;
  const response = await fetch(`${options.apiBase}/api/workspace/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      displayName: `Eval profile (${key})`.slice(0, 200),
      designation: "Evaluation",
      preferredLanguage: "en",
      defaultScope: "my_departments",
      primaryDepartment: primary ?? null,
      additionalDepartments: additional,
      additionalChargeDepartments: [],
    }),
  });
  if (!response.ok) {
    throw new Error(`Could not create eval profile: ${response.status} ${await response.text()}`);
  }
  const created = (await response.json()) as { id: string };
  evalUsers[key] = created.id;
  await mkdir(path.dirname(EVAL_USERS_PATH), { recursive: true });
  await writeFile(EVAL_USERS_PATH, JSON.stringify(evalUsers, null, 2) + "\n", "utf8");
  return created.id;
}

/** The orders an answer cited (all shown orders when it cited none). */
function citedSourceIds(result: ChatResult): string[] {
  const labels = new Set(
    (result.done?.citations ?? [])
      .map((citation) => /S\d+/.exec(citation)?.[0])
      .filter((label): label is string => Boolean(label)),
  );
  const cited = result.sources.filter((source) => labels.has(source.label));
  return [...new Set((cited.length ? cited : result.sources).map((source) => source.sourceId))].slice(0, 8);
}

async function runChat(
  testCase: EvalCase,
  options: CliOptions,
): Promise<ChatResult> {
  if (!testCase.previousQuery) return runChatTurn(testCase, options, [testCase.query], {});
  const first = await runChatTurn(testCase, options, [testCase.previousQuery], {});
  if (first.error) return { ...first, error: `first turn: ${first.error}` };
  const previousSourceIds = citedSourceIds(first);
  const second = await runChatTurn(testCase, options, [testCase.previousQuery, testCase.query], {
    followUp: true,
    followSourceIds: previousSourceIds,
  });
  return { ...second, previousSourceIds, elapsedMs: second.elapsedMs };
}

async function runChatTurn(
  testCase: EvalCase,
  options: CliOptions,
  questions: string[],
  extraBody: Record<string, unknown>,
): Promise<ChatResult> {
  const workspaceUserId = testCase.profileDepartments?.length
    ? await evalUserFor(testCase.profileDepartments, options)
    : undefined;

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
          messages: questions.map((content) => ({
            role: "user",
            content,
          })),
          ...(workspaceUserId ? { workspaceUserId } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...extraBody,
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

  // A general-knowledge answer (ADR-083) is the app saying "not in the
  // archive" while still helping: right for out-of-archive questions, a miss
  // for questions the archive answers. It has no pages to validate against.
  const generalKnowledge = (chat.done as { generalKnowledge?: boolean } | null)?.generalKnowledge ?? false;

  if (validated !== true && !generalKnowledge) {
    failures.push(
      "answer was not validated",
    );
  }

  const noEvidence = (chat.done?.noEvidence ?? false) || generalKnowledge;
  const answerWords =
    (chat.answer.replace(CITATION_RE, "").match(/[\p{L}\p{M}]+/gu) ?? []).length;
  CITATION_RE.lastIndex = 0;

  if (testCase.expectNoEvidence) {
    // The only right answer is "no matching order", without citations/sources.
    if (!noEvidence && !chat.done?.conversational) {
      failures.push("expected 'no matching order', but an answer was given");
    }
  } else {
    if (noEvidence) {
      failures.push(
        generalKnowledge
          ? "answered from general knowledge although the archive has the order"
          : "answered 'no matching order' although the archive has the order",
      );
    }
    if (answerWords < 5) {
      failures.push(`answer has almost no text (${answerWords} words besides citations)`);
    }
    // Ends mid-word unless the API said it shortened the answer cleanly.
    if (
      !chat.done?.shortened &&
      answerWords >= 5 &&
      // Closing markdown (**bold**, *italic*) after the punctuation is fine.
      !/[।॥.?!)\]:]\s*$/u.test(chat.answer.trim().replace(/[*_\s]+$/u, ""))
    ) {
      failures.push("answer seems cut off (no final punctuation)");
    }
    if (
      testCase.expectedTextIncludesAny?.length &&
      !testCase.expectedTextIncludesAny.some((word) =>
        chat.answer.replace(/[\u200c\u200d]/g, "").includes(word),
      )
    ) {
      failures.push(`answer mentions none of: ${testCase.expectedTextIncludesAny.join(", ")}`);
    }
  }

  if (testCase.expectListing && !(chat.done as { listing?: boolean } | undefined)?.listing) {
    failures.push("expected an order list (newest first), but Ask answered from page text");
  }

  const shownSourceIds = [...new Set(chat.sources.map((source) => source.sourceId))];
  if (testCase.expectOnlyPreviousSources && chat.previousSourceIds) {
    const allowed = new Set(chat.previousSourceIds);
    const outside = shownSourceIds.filter((id) => !allowed.has(id));
    if (outside.length) {
      failures.push(`follow-up left the cited orders: ${outside.slice(0, 3).join(", ")}`);
    }
  }
  if (
    testCase.expectedChatSourceIdsAny?.length &&
    !noEvidence &&
    !testCase.expectedChatSourceIdsAny.some((id) => shownSourceIds.includes(id))
  ) {
    failures.push(`answer shows none of the expected orders: ${testCase.expectedChatSourceIdsAny.join(", ")}`);
  }
  const forbidden = shownSourceIds.filter((id) =>
    (testCase.forbiddenSourcePrefixes ?? []).some((prefix) => id.startsWith(prefix)),
  );
  if (forbidden.length) {
    failures.push(`answer used sources it should not: ${forbidden.slice(0, 3).join(", ")}`);
  }

  if (testCase.expectScopeFallback && !chat.done?.scopeFallback) {
    failures.push("expected a search beyond the profile's departments (scopeFallback)");
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

  const citedLabels = new Set(citations.map((citation) => citation.label));
  const citedAuthorities = [
    ...new Set(
      chat.sources
        .filter((source) => citedLabels.has(source.label))
        .map((source) => source.authority ?? "UNCLASSIFIED"),
    ),
  ].sort();
  if (
    testCase.expectGeneralSource &&
    citations.length > 0 &&
    !citedAuthorities.some((kind) => kind === "RULEBOOK" || kind === "GENERAL")
  ) {
    failures.push(`cited no rulebook or general order (cited: ${citedAuthorities.join(", ") || "-"})`);
  }

  if (
    testCase.requireCitation &&
    !testCase.expectNoEvidence &&
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
    citedAuthorities,
    model: chat.done?.model,
    usage: chat.done?.usage,
    modelFellBack: chat.done?.modelFellBack,
    citationCount:
      citations.length,
    expectedCitationPageHit,
    internalPlaceholderLeak,
    firstValidationIssues:
      chat.done
        ?.firstValidationIssues ??
      [],
    firstValidationExcerpts: chat.done?.firstValidationExcerpts ?? [],
    citationsAdded: chat.done?.citationsAdded ?? 0,
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
    category: testCase.category,
    expectNoEvidence: testCase.expectNoEvidence ?? false,
    expectGeneralSource: testCase.expectGeneralSource ?? false,
    noEvidence,
    noEvidenceReason: chat.done?.noEvidenceReason,
    generalKnowledge: (chat.done as { generalKnowledge?: boolean } | null)?.generalKnowledge ?? false,
    shortened: chat.done?.shortened ?? false,
    scopeFallback: chat.done?.scopeFallback ?? false,
    bestRelevance: chat.done?.bestRelevance ?? null,
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

/**
 * Suggest RAG_MIN_RELEVANCE from this run: answerable cases should sit above
 * the threshold, "not found" cases below it. Reported, never applied.
 */
function relevanceCalibration(results: CaseResult[]) {
  const answerable = results
    .filter((item) => !item.expectNoEvidence && typeof item.bestRelevance === "number")
    .map((item) => item.bestRelevance as number)
    .sort((a, b) => a - b);
  const unanswerable = results
    .filter((item) => item.expectNoEvidence && typeof item.bestRelevance === "number")
    .map((item) => item.bestRelevance as number)
    .sort((a, b) => a - b);
  const lowestAnswerable = answerable[0] ?? null;
  const highestUnanswerable = unanswerable.at(-1) ?? null;
  const suggestion =
    lowestAnswerable !== null && highestUnanswerable !== null && highestUnanswerable < lowestAnswerable
      ? Number(((lowestAnswerable + highestUnanswerable) / 2).toFixed(3))
      : null;
  return { lowestAnswerable, highestUnanswerable, suggestion };
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
    notFoundCorrectRate: rate(
      results.filter((item) => item.expectNoEvidence).map((item) => item.passed),
    ),
    falseNotFoundRate: rate(
      results.filter((item) => !item.expectNoEvidence && item.noEvidence !== undefined).map((item) => item.noEvidence ?? null),
    ),
    shortenedRate: rate(results.map((item) => item.shortened ?? null)),
    // Answers that cite a rulebook or a general order, among answers with citations.
    generalSourceRate: rate(
      results
        .filter((item) => item.expectGeneralSource && (item.citedAuthorities?.length ?? 0) > 0)
        .map((item) => item.citedAuthorities!.some((kind) => kind === "RULEBOOK" || kind === "GENERAL")),
    ),
    // Answers the fallback model wrote: a mixed run is not a fair model comparison.
    modelFellBackRate: rate(results.map((item) => item.modelFellBack ?? null)),
    models: [...new Set(results.map((item) => item.model).filter((model): model is string => Boolean(model)))],
    // Answer-model cost (OpenRouter-reported), per answered question (ADR-100).
    totalCostUsd: Number(results.reduce((sum, item) => sum + (item.usage?.costUsd ?? 0), 0).toFixed(4)),
    meanCostUsd: (() => {
      const costs = results.map((item) => item.usage?.costUsd).filter((value): value is number => typeof value === "number");
      return costs.length ? Number((costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(5)) : null;
    })(),
    meanCompletionTokens: (() => {
      const tokens = results.map((item) => item.usage?.completionTokens).filter((value): value is number => typeof value === "number");
      return tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : null;
    })(),
    scopeFallbackRate: rate(results.map((item) => item.scopeFallback ?? null)),
    relevance: relevanceCalibration(results),
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
    `| "Not found" answered correctly | ${pct(summary.notFoundCorrectRate)} |`,
    `| Wrong "not found" on answerable questions | ${pct(summary.falseNotFoundRate)} |`,
    `| Shortened answers | ${pct(summary.shortenedRate)} |`,
    `| Answers citing a rulebook or general order | ${pct(summary.generalSourceRate)} |`,
    `| Answer model(s) | ${summary.models.join(", ") || "-"} |`,
    `| Answer-model cost: total / per question | $${summary.totalCostUsd} / ${summary.meanCostUsd === null ? "-" : `$${summary.meanCostUsd}`} |`,
    `| Written by the fallback model | ${pct(summary.modelFellBackRate)} |`,
    `| Searched beyond profile departments | ${pct(summary.scopeFallbackRate)} |`,
    `| Best match: lowest answerable / highest not-found | ${summary.relevance.lowestAnswerable ?? "-"} / ${summary.relevance.highestUnanswerable ?? "-"} |`,
    `| Suggested RAG_MIN_RELEVANCE | ${summary.relevance.suggestion ?? "not separable yet"} |`,
    "",
    "## Cases",
    "",
    "| Case | Pass | Source | Page | Validated | Salvage | Fallback | Not found | Shortened | Best match | Chat latency |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: |",
  ];

  for (const result of results) {
    lines.push(
      `| ${result.id} | ${result.passed ? "PASS" : "FAIL"} | ${result.sourceHitAtK === null ? "-" : result.sourceHitAtK ? "yes" : "no"} | ${result.pageHitAtK === null ? "-" : result.pageHitAtK ? "yes" : "no"} | ${result.validated === null ? "-" : result.validated ? "yes" : "no"} | ${result.usedQualitativeSalvage === null ? "-" : result.usedQualitativeSalvage ? "yes" : "no"} | ${result.usedFallback === null ? "-" : result.usedFallback ? "yes" : "no"} | ${result.noEvidence ? "yes" : "no"} | ${result.shortened ? "yes" : "no"} | ${typeof result.bestRelevance === "number" ? result.bestRelevance.toFixed(2) : "-"} | ${ms(result.chatMs)} |`,
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

  console.log(`"Not found" correct:    ${pct(summary.notFoundCorrectRate)}`);
  console.log(`Wrong "not found":      ${pct(summary.falseNotFoundRate)}`);
  console.log(`Shortened answers:      ${pct(summary.shortenedRate)}`);
  console.log(
    `Best match (answerable min / not-found max): ${summary.relevance.lowestAnswerable ?? "-"} / ${summary.relevance.highestUnanswerable ?? "-"}` +
      (summary.relevance.suggestion !== null ? ` → suggested RAG_MIN_RELEVANCE ${summary.relevance.suggestion}` : ""),
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
      `Answer model(s):        ${summary.models.join(", ") || "-"} (fallback wrote ${pct(summary.modelFellBackRate)})`,
    );
    console.log(`Answer-model cost:      $${summary.totalCostUsd} total, ${summary.meanCostUsd === null ? "-" : `$${summary.meanCostUsd}`} per question, ${summary.meanCompletionTokens ?? "-"} tokens written`);
  }

  const runAt =
    new Date().toISOString();

  const safeStamp =
    (options.label ? `${options.label}-` : "") +
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
