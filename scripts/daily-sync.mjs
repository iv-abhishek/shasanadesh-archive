#!/usr/bin/env node
/**
 * Daily sync (npm run sync:daily) — ROADMAP §5, ADR-055.
 *
 * Runs the pipeline in order and writes a report:
 *
 *   ingest (only with --ingest)   ingest:sources, ingest:portal --until-idle
 *   classify:orders               tiers decide what the heavy steps skip
 *   storage:restore --needed      originals back from B2 for orders now tier A/B
 *   ocr:needs, build:pages        new/scanned documents → page text
 *   compare:suspicious --max N    selective OCR for garbled native pages
 *   build:retrieval-variants, build:retrieval-variant-chunks
 *   relations:build               "amended / superseded by" links (ADR-054)
 *   db:load, embed:chunks         Postgres + embeddings for new chunks only
 *   embed:subjects                subject vectors for finding orders (ADR-058)
 *   translit:lexicon              Hindi word list for Hinglish typing (ADR-061)
 *   chats:archive                 chats inactive for a month → Archives (ADR-066)
 *   storage:trim --apply          drop local copies B2 already holds (ADR-056)
 *   portal:report, storage:report reconciliation and disk use (information only)
 *
 * Every stage is incremental, so a day without new documents finishes quickly.
 * Fetching is OFF unless --ingest (or SYNC_INGEST=1) is given: the portal's new
 * listings still come from a person's capture through portal:bridge (the search
 * CAPTCHA is never automated), and ingest:portal only downloads what was
 * captured. Ingestion is on hold until Abhishek restarts it.
 *
 * Flags: --ingest  --dry-run  --ocr-max N (default 150)  --skip <step,...>
 * Output: data/sync/reports/<date>.md (+ .json), step logs in data/sync/logs/.
 * One run at a time (data/sync/lock; a lock older than 12 h is taken over).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, createWriteStream, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const syncDir = path.join(root, "data/sync");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const ingest = flag("--ingest") || process.env.SYNC_INGEST === "1";
const dryRun = flag("--dry-run");
const ocrMax = String(Number(option("--ocr-max", "150")) || 150);
const skip = new Set(option("--skip", "").split(",").map((s) => s.trim()).filter(Boolean));

/** name, npm script args, whether a failure stops the run. */
const STEPS = [
  { name: "db:check", run: ["db:check"], critical: true },
  ...(ingest
    ? [
        { name: "ingest:sources", run: ["ingest:sources"], critical: false },
        // Re-reads a Financial Handbook volume only when its last read is 30+ days old.
        { name: "ingest:handbook", run: ["ingest:handbook"], critical: false },
        { name: "ingest:portal", run: ["ingest:portal", "--", "--until-idle"], critical: false },
      ]
    : []),
  { name: "sources:audit", run: ["sources:audit"], critical: false },
  { name: "classify:orders", run: ["classify:orders"], critical: true },
  { name: "storage:restore", run: ["storage:restore", "--", "--needed"], critical: false },
  { name: "ocr:needs", run: ["ocr:needs"], critical: false },
  { name: "build:pages", run: ["build:pages"], critical: true },
  { name: "compare:suspicious", run: ["compare:suspicious", "--", "--max", ocrMax], critical: false },
  { name: "build:retrieval-variants", run: ["build:retrieval-variants"], critical: true },
  { name: "build:retrieval-variant-chunks", run: ["build:retrieval-variant-chunks"], critical: true },
  { name: "relations:build", run: ["relations:build"], critical: false },
  { name: "db:load", run: ["db:load"], critical: true },
  { name: "embed:chunks", run: ["embed:chunks"], critical: true },
  { name: "embed:subjects", run: ["embed:subjects"], critical: false },
  { name: "translit:lexicon", run: ["translit:lexicon"], critical: false },
  { name: "chats:archive", run: ["chats:archive"], critical: false },
  { name: "storage:trim", run: ["storage:trim", "--", "--apply"], critical: false },
  { name: "portal:report", run: ["portal:report"], critical: false },
  { name: "storage:report", run: ["storage:report"], critical: false },
].filter((step) => !skip.has(step.name));

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
// Dates in the report follow the app's display zone (IST by default).
const zone = process.env.APP_TIME_ZONE || "Asia/Kolkata";
const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const clock = () => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());

function countDocuments() {
  const dir = path.join(root, "data/documents");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

function tail(file, lines = 25) {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function runStep(step, logFile) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = createWriteStream(logFile);
    const child = spawn("npm", ["run", "-s", ...step.run], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("close", (code) => {
      log.end();
      resolve({ code: code ?? 1, seconds: Math.round((Date.now() - started) / 1000) });
    });
    child.on("error", (error) => {
      log.end(String(error));
      resolve({ code: 1, seconds: 0 });
    });
  });
}

function acquireLock() {
  const lock = path.join(syncDir, "lock");
  if (existsSync(lock)) {
    const ageHours = (Date.now() - statSync(lock).mtimeMs) / 3_600_000;
    if (ageHours < 12) {
      console.error(`Another sync is running (lock ${lock}, ${ageHours.toFixed(1)} h old). Exiting.`);
      process.exit(2);
    }
  }
  writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`);
  return () => rmSync(lock, { force: true });
}

function notify(title, message) {
  if (os.platform() !== "darwin") return;
  const quote = (text) => `"${text.replace(/["\\]/g, "")}"`;
  spawn("osascript", ["-e", `display notification ${quote(message)} with title ${quote(title)}`], { stdio: "ignore" }).on("error", () => {});
}

async function main() {
  console.log(`Daily sync ${stamp} (${ingest ? "with ingestion" : "processing only; fetching is off"})`);
  if (dryRun) {
    for (const step of STEPS) console.log(`  npm run ${step.run.join(" ")}${step.critical ? "" : "   (non-critical)"}`);
    return;
  }

  mkdirSync(path.join(syncDir, "logs"), { recursive: true });
  mkdirSync(path.join(syncDir, "reports"), { recursive: true });
  const release = acquireLock();
  const before = countDocuments();
  const results = [];
  let stopped = null;

  try {
    for (const step of STEPS) {
      const logFile = path.join(syncDir, "logs", `${stamp}-${step.name.replace(/:/g, "-")}.log`);
      process.stdout.write(`[${clock()}] ${step.name} … `);
      const { code, seconds } = await runStep(step, logFile);
      const ok = code === 0;
      console.log(ok ? `ok (${seconds}s)` : `FAILED (exit ${code}, ${seconds}s) — ${path.relative(root, logFile)}`);
      results.push({ step: step.name, ok, code, seconds, log: path.relative(root, logFile), tail: ok ? tail(logFile, 12) : tail(logFile, 40) });
      if (!ok && step.critical) {
        stopped = step.name;
        break;
      }
    }
  } finally {
    release();
  }

  const after = countDocuments();
  const failed = results.filter((result) => !result.ok);
  const report = [
    `# Daily sync — ${stamp}`,
    "",
    `- Mode: ${ingest ? "ingestion + processing" : "processing only (fetching off)"}`,
    `- Documents on disk: ${before} → ${after} (${after - before >= 0 ? "+" : ""}${after - before})`,
    `- Result: ${stopped ? `**stopped at ${stopped}**` : failed.length ? `finished with ${failed.length} non-critical failure(s)` : "all steps passed"}`,
    "",
    "| Step | Result | Time |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.step} | ${r.ok ? "ok" : `failed (exit ${r.code})`} | ${r.seconds}s |`),
    "",
    ...results.flatMap((r) => [`## ${r.step}`, "", "```", r.tail || "(no output)", "```", ""]),
  ].join("\n");
  const reportFile = path.join(syncDir, "reports", `${stamp}.md`);
  writeFileSync(reportFile, report);
  writeFileSync(reportFile.replace(/\.md$/, ".json"), JSON.stringify({ date: stamp, ingest, before, after, stopped, results }, null, 2));
  console.log(`Report: ${path.relative(root, reportFile)}`);

  notify(
    "Shasanadesh daily sync",
    stopped ? `Stopped at ${stopped}. See the report.` : `Done: ${after - before} new documents, ${failed.length} warnings.`,
  );
  process.exitCode = stopped ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
