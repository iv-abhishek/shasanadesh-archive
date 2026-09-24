import {
  readFile,
} from "node:fs/promises";

interface Filters {
  department?: string;
  goNumber?: string;
  sourceId?: string;
  dateFrom?: string;
  dateTo?: string;
  verificationStatus?: string;
}

interface ExpectAll {
  department?: string;
  sourceId?: string;
  verificationStatus?: string;
}

interface FilterCase {
  id: string;
  query: string;
  topK?: number;
  filters: Filters;
  expectedSourceIds?: string[];
  expectedPages?: number[];
  expectAll?: ExpectAll;
  notes?: string;
}

interface Evidence {
  source_id: string;
  page_number: number;
  department: string | null;
  numeric_verification_status?: string;
}

interface SearchResponse {
  evidence: Evidence[];
}

const API_BASE =
  process.env.RAG_API_BASE_URL ??
  "http://127.0.0.1:8787";

const CASES_PATH =
  process.env.RAG_FILTER_EVAL_CASES ??
  "eval/filter-cases.json";

const TIMEOUT_MS =
  Number.parseInt(
    process.env.RAG_EVAL_TIMEOUT_MS ??
      "1200000",
    10,
  );

async function search(
  testCase: FilterCase,
): Promise<{
  response: SearchResponse;
  elapsedMs: number;
}> {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      TIMEOUT_MS,
    );

  const started =
    performance.now();

  try {
    const response =
      await fetch(
        `${API_BASE}/api/search`,
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
              testCase.topK ?? 12,
            filters:
              testCase.filters,
          }),
          signal:
            controller.signal,
        },
      );

    const elapsedMs =
      performance.now() -
      started;

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
  } finally {
    clearTimeout(timer);
  }
}

function evaluate(
  testCase: FilterCase,
  evidence: Evidence[],
): string[] {
  const failures: string[] = [];

  if (evidence.length === 0) {
    failures.push(
      "No evidence returned.",
    );

    return failures;
  }

  if (
    testCase.expectedSourceIds &&
    testCase.expectedSourceIds.length > 0
  ) {
    const actual =
      new Set(
        evidence.map(
          (item) =>
            item.source_id,
        ),
      );

    for (
      const expected of
        testCase.expectedSourceIds
    ) {
      if (!actual.has(expected)) {
        failures.push(
          `Expected source missing: ${expected}`,
        );
      }
    }
  }

  if (
    testCase.expectedPages &&
    testCase.expectedPages.length > 0
  ) {
    const actual =
      new Set(
        evidence.map(
          (item) =>
            item.page_number,
        ),
      );

    for (
      const expected of
        testCase.expectedPages
    ) {
      if (!actual.has(expected)) {
        failures.push(
          `Expected page missing: ${expected}`,
        );
      }
    }
  }

  const expectAll =
    testCase.expectAll;

  if (expectAll?.department) {
    const bad =
      evidence.filter(
        (item) =>
          item.department !==
          expectAll.department,
      );

    if (bad.length > 0) {
      failures.push(
        `${bad.length} result(s) violated department=${expectAll.department}`,
      );
    }
  }

  if (expectAll?.sourceId) {
    const bad =
      evidence.filter(
        (item) =>
          item.source_id !==
          expectAll.sourceId,
      );

    if (bad.length > 0) {
      failures.push(
        `${bad.length} result(s) violated sourceId=${expectAll.sourceId}`,
      );
    }
  }

  if (
    expectAll?.verificationStatus
  ) {
    const bad =
      evidence.filter(
        (item) =>
          item
            .numeric_verification_status !==
          expectAll
            .verificationStatus,
      );

    if (bad.length > 0) {
      failures.push(
        `${bad.length} result(s) violated verificationStatus=${expectAll.verificationStatus}`,
      );
    }
  }

  return failures;
}

async function main():
  Promise<void> {
  const health =
    await fetch(
      `${API_BASE}/health`,
    );

  if (!health.ok) {
    throw new Error(
      `API health failed: ${health.status}`,
    );
  }

  const cases =
    JSON.parse(
      await readFile(
        CASES_PATH,
        "utf8",
      ),
    ) as FilterCase[];

  console.log(
    `Retrieval filter evaluation: ${cases.length} case(s)`,
  );

  let passed = 0;

  for (
    let index = 0;
    index < cases.length;
    index += 1
  ) {
    const testCase =
      cases[index];

    const {
      response,
      elapsedMs,
    } =
      await search(testCase);

    const failures =
      evaluate(
        testCase,
        response.evidence,
      );

    const ok =
      failures.length === 0;

    if (ok) {
      passed += 1;
    }

    console.log(
      `[${index + 1}/${cases.length}] ${testCase.id}: ${ok ? "PASS" : "FAIL"} | ${(elapsedMs / 1000).toFixed(1)} s | ${response.evidence.length} result(s)`,
    );

    for (
      const failure of failures
    ) {
      console.log(
        `  - ${failure}`,
      );
    }
  }

  console.log();
  console.log(
    `Passed: ${passed}/${cases.length}`,
  );

  if (
    passed !== cases.length
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
