/**
 * Model bake-off (ADR-100): run the same eval with several answer models and
 * write one comparison.
 *
 *   RAG_ALLOW_MODEL_OVERRIDE=1 in .env, restart the API, then:
 *   npm run eval:bakeoff -- --models qwen/qwen3.6-35b-a3b,google/gemini-3.8-flash
 *   (add --limit 20 for a quick first pass; other eval options pass through)
 *
 * Retrieval is identical for every model (same index, same rewording model);
 * only the model that writes and repairs the answer changes.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface Report {
  options: { model: string | null };
  summary: Record<string, unknown> & {
    passRate: number | null;
    validatedRate: number | null;
    fallbackRate: number | null;
    salvageRate: number | null;
    falseNotFoundRate: number | null;
    notFoundCorrectRate: number | null;
    expectedCitationPageHitRate: number | null;
    medianChatMs: number | null;
    totalCostUsd: number;
    meanCostUsd: number | null;
    meanCompletionTokens: number | null;
    modelFellBackRate: number | null;
  };
  results: Array<{ id: string; query: string; passed: boolean; answer: string | null; failures: string[] }>;
}

const RUNS = path.join("data", "eval", "runs");
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${(v * 100).toFixed(1)}%`);

async function latestReport(label: string): Promise<string> {
  const files = (await readdir(RUNS)).filter((name) => name.startsWith(`${label}-`) && name.endsWith(".json")).sort();
  if (!files.length) throw new Error(`no report for ${label}`);
  return path.join(RUNS, files[files.length - 1]);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--models");
  if (at < 0 || !argv[at + 1]) throw new Error("Usage: npm run eval:bakeoff -- --models a/b,c/d [--limit N]");
  const models = argv[at + 1].split(",").map((m) => m.trim()).filter(Boolean);
  const passThrough = argv.filter((_, i) => i !== at && i !== at + 1);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(RUNS, { recursive: true });

  const reports: Array<{ model: string; report: Report }> = [];
  for (const model of models) {
    const label = `bakeoff-${stamp}-${model.replace(/[^a-z0-9.]+/gi, "_")}`;
    console.log(`\n=== ${model} ===`);
    const run = spawnSync(
      process.execPath,
      ["--env-file-if-exists=.env", "--import", "tsx", "src/eval/run-rag-eval.ts", "--model", model, "--label", label, ...passThrough],
      { stdio: "inherit" },
    );
    if (run.status !== 0) {
      console.error(`${model}: eval failed (exit ${run.status}); skipping`);
      continue;
    }
    const report = JSON.parse(await readFile(await latestReport(label), "utf8")) as Report;
    if ((report.summary.modelFellBackRate ?? 0) > 0) console.warn(`${model}: some answers came from the fallback model`);
    reports.push({ model, report });
  }
  if (!reports.length) throw new Error("no model finished");

  const lines = [
    `# Model bake-off ${stamp}`,
    "",
    "Same questions, same retrieval; only the answer model changes. Cost is the answer model's (OpenRouter-reported).",
    "",
    "| Model | Pass | Validated | Fallback | Salvage | Wrong not-found | Not-found right | Cited expected page | Median answer time | Cost / question | Tokens written |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...reports.map(({ model, report: { summary: s } }) =>
      `| ${model} | ${pct(s.passRate)} | ${pct(s.validatedRate)} | ${pct(s.fallbackRate)} | ${pct(s.salvageRate)} | ${pct(s.falseNotFoundRate)} | ${pct(s.notFoundCorrectRate)} | ${pct(s.expectedCitationPageHitRate)} | ${s.medianChatMs ? `${(s.medianChatMs / 1000).toFixed(1)} s` : "-"} | ${s.meanCostUsd === null ? "-" : `$${s.meanCostUsd.toFixed(4)}`} | ${s.meanCompletionTokens ?? "-"} |`,
    ),
    "",
    "## Answers side by side",
    "",
  ];
  const ids = reports[0].report.results.map((r) => r.id);
  for (const id of ids) {
    const first = reports[0].report.results.find((r) => r.id === id)!;
    lines.push(`### ${id}`, "", `> ${first.query}`, "");
    for (const { model, report } of reports) {
      const r = report.results.find((x) => x.id === id);
      if (!r) continue;
      lines.push(
        `**${model}** — ${r.passed ? "PASS" : `FAIL (${r.failures.join("; ")})`}`,
        "",
        (r.answer ?? "(no answer)").slice(0, 900).replace(/\n{2,}/g, "\n"),
        "",
      );
    }
  }
  const out = path.join(RUNS, `bakeoff-${stamp}.md`);
  await writeFile(out, lines.join("\n") + "\n");
  console.log(`\n${lines.slice(4, 6 + reports.length).join("\n")}\n\nComparison: ${out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
