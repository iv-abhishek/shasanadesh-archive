#!/usr/bin/env node
/**
 * Start the whole local stack with one command:  npm run dev:all
 *
 *   generator  MLX Qwen model server        http://127.0.0.1:8791
 *   retrieval  embeddings + reranker        http://127.0.0.1:8788
 *   api        TypeScript RAG / workspace   http://127.0.0.1:8787
 *   web        Next.js frontend             http://127.0.0.1:3000
 *
 * Services that are already running (their health URL answers) are reused,
 * not started twice. Output is prefixed per service. Ctrl+C stops every
 * service this command started.
 *
 * Options:
 *   --no-generator   use a hosted LLM_BASE_URL/LLM_MODEL from .env instead of MLX
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const useLocalGenerator = !process.argv.includes("--no-generator");

const colors = { generator: 35, retrieval: 36, api: 33, web: 32, dev: 1 };
const log = (name, line) =>
  process.stdout.write(`\x1b[${colors[name] ?? 0}m${name.padEnd(9)}\x1b[0m | ${line}\n`);

const services = [
  ...(useLocalGenerator
    ? [{ name: "generator", script: "generator:serve", health: "http://127.0.0.1:8791/v1/models" }]
    : []),
  { name: "retrieval", script: "retrieval:serve", health: "http://127.0.0.1:8788/health" },
  {
    name: "api",
    script: useLocalGenerator ? "api:dev:local-generator" : "api:dev",
    health: "http://127.0.0.1:8787/health",
  },
  { name: "web", script: "web:dev", health: "http://127.0.0.1:3000/" },
];

async function healthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function checkDatabase() {
  if (!process.env.DATABASE_URL) {
    log("dev", "DATABASE_URL is not set in .env. Add it, then run npm run dev:all again.");
    return false;
  }
  try {
    const { Client } = require("pg");
    const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 4000 });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    log("dev", "PostgreSQL reachable");
    return true;
  } catch (error) {
    log("dev", `PostgreSQL is not reachable (${error.message}).`);
    log("dev", "Start it with: brew services start postgresql@16   (or: npm run db:up for Docker)");
    return false;
  }
}

const children = [];
let stopping = false;

function start(service) {
  const child = spawn("npm", ["run", "--silent", service.script], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group so Ctrl+C can stop npm and its children
  });
  children.push({ service, child });

  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) log(service.name, line);
    });
  }

  child.on("exit", (code, signal) => {
    if (!stopping) {
      log("dev", `${service.name} stopped (${signal ?? `exit ${code}`}). Other services keep running; fix the error above and rerun npm run dev:all.`);
    }
  });
}

async function waitUntilHealthy(service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    if (await healthy(service.health)) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  log("dev", "stopping services…");
  for (const { child } of children) {
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {
      // already exited
    }
  }
  setTimeout(() => {
    for (const { child } of children) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
    process.exit(0);
  }, 5000).unref();
  Promise.all(children.map(({ child }) => new Promise((resolve) => (child.exitCode !== null ? resolve() : child.on("exit", resolve))))).then(() =>
    process.exit(0),
  );
}

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

if (!(await checkDatabase())) process.exit(1);

for (const service of services) {
  if (await healthy(service.health)) {
    log("dev", `${service.name} already running at ${service.health} — reusing it`);
    continue;
  }
  log("dev", `starting ${service.name} (npm run ${service.script})`);
  start(service);
}

// Models take a while to load on first start; report readiness as it happens.
const results = await Promise.all(
  services.map(async (service) => {
    const ok = await waitUntilHealthy(service, 10 * 60 * 1000);
    if (ok) log("dev", `✓ ${service.name} ready`);
    else if (!stopping) log("dev", `✗ ${service.name} did not become ready — see its log lines above`);
    return ok;
  }),
);

if (results.every(Boolean)) {
  log("dev", "All services ready → open http://127.0.0.1:3000   (Ctrl+C stops everything)");
}
