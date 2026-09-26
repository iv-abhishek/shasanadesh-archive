#!/usr/bin/env node
/**
 * Pipeline stage: project handoff
 *
 * Purpose:
 *   Regenerate handoff/SNAPSHOT.md with facts a new session needs and should
 *   not have to rediscover: git state, recent commits, uncommitted files, and
 *   corpus/B2 counts per source collection.
 *
 * Invariants:
 *   - read-only apart from writing handoff/SNAPSHOT.md
 *   - never prints environment values (only whether B2 is configured)
 *
 * Usage: npm run handoff:snapshot
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const timeZone = process.env.APP_TIME_ZONE?.trim() || "Asia/Kolkata";

function git(args) {
  try {
    // --no-optional-locks: do not leave .git/index.lock behind.
    return execFileSync("git", ["--no-optional-locks", ...args], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "(git unavailable)";
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function countLines(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).length;
}

const now = new Date();
const stamp = now.toLocaleString("en-IN", { timeZone, dateStyle: "medium", timeStyle: "short" });

// Corpus counts, grouped by the provider recorded in each capture's metadata.
const documentsRoot = path.join(root, "data/documents");
const byProvider = new Map();
if (existsSync(documentsRoot)) {
  for (const entry of readdirSync(documentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(documentsRoot, entry.name);
    const metadata = readJson(path.join(dir, "metadata.json"));
    if (!metadata) continue;
    const provider = metadata.provider ?? "unknown";
    const row = byProvider.get(provider) ?? { documents: 0, inB2: 0, pages: 0, ocrPages: 0 };
    row.documents += 1;
    if (metadata.storage?.raw?.fileId) row.inB2 += 1;
    row.pages += countLines(path.join(dir, "pages.jsonl"));
    const ocrDir = path.join(dir, "ocr-selective");
    if (existsSync(ocrDir)) row.ocrPages += readdirSync(ocrDir).filter((f) => f.endsWith(".txt")).length;
    byProvider.set(provider, row);
  }
}

const crawlState = readJson(path.join(root, "data/crawl/shasanadesh-state.json"));

// Portal capture (npm run portal:bridge + ingest:portal): listing progress and
// importer outcomes. The importer's status log is append-only, so the last
// entry per order is its current state.
const portalDir = path.join(root, "data/portal-capture");
const portalInventory = countLines(path.join(portalDir, "inventory.jsonl"));
const portalPages = countLines(path.join(portalDir, "pages.jsonl"));
const portalStates = new Map();
const statusFile = path.join(portalDir, "ingest-status.jsonl");
if (existsSync(statusFile)) {
  for (const line of readFileSync(statusFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      portalStates.set(row.sourceId, row.state);
    } catch {
      // Ignore a partly written last line.
    }
  }
}
const portalCount = (state) => [...portalStates.values()].filter((value) => value === state).length;
const portalStored = portalCount("stored") + portalCount("skipped");
const queueFile = path.join(root, "datasets/submissions.jsonl");

const lines = [
  "# Snapshot (generated)",
  "",
  `Generated ${stamp} (${timeZone}) by \`npm run handoff:snapshot\`. Do not edit by hand.`,
  "",
  "## Git",
  "",
  `- Branch: \`${git(["rev-parse", "--abbrev-ref", "HEAD"])}\``,
  `- HEAD: \`${git(["log", "-1", "--format=%h %s"])}\``,
  `- Unpushed commits: ${git(["rev-list", "--count", "@{u}..HEAD"]).replace("(git unavailable)", "unknown (no upstream)")}`,
  "",
  "Uncommitted files:",
  "",
  "```",
  git(["status", "--short"]) || "(clean)",
  "```",
  "",
  "Recent commits:",
  "",
  "```",
  git(["log", "--oneline", "-15"]),
  "```",
  "",
  "## Corpus by source",
  "",
  "| Provider | Documents | In B2 | Pages | Selective-OCR pages |",
  "|---|---:|---:|---:|---:|",
  ...[...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, row]) => `| ${provider} | ${row.documents} | ${row.inB2} | ${row.pages} | ${row.ocrPages} |`),
  "",
  `- Retrieval variant chunks: ${countLines(path.join(root, "data/corpus/retrieval-variant-chunks.jsonl"))}`,
  `- B2 configured: ${process.env.B2_KEY_ID ? "yes" : "no (or .env not loaded)"}`,
  `- Submission queue entries: ${countLines(queueFile)}`,
  crawlState
    ? `- Shasanadesh crawl: ${crawlState.totals?.found ?? 0} found, ${crawlState.totals?.requests ?? 0} requests, last run ${crawlState.lastRunAt ?? "never"}`
    : "- Shasanadesh crawl: not started",
  "",
  "## Shasanadesh portal capture",
  "",
  portalInventory
    ? [
        `- Listing: ${portalInventory} unique orders from ${portalPages} result pages`,
        `- In B2: ${portalStored} · not yet stored: ${portalInventory - portalStored - portalCount("unavailable")} · retrying: ${portalCount("retry")} · unavailable (404/410): ${portalCount("unavailable")}`,
        `- Listing complete: ${existsSync(path.join(portalDir, "complete.json")) ? "yes" : "no"}`,
      ].join("\n")
    : "- Not started",
  "",
];

writeFileSync(path.join(root, "handoff/SNAPSHOT.md"), lines.join("\n"));
console.log("Wrote handoff/SNAPSHOT.md");
