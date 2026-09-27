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
 * A port that is taken by a busy earlier run (the model mid-answer, Next.js
 * compiling) is also reused instead of starting a second copy that would fail
 * with "address already in use".
 *
 * Options:
 *   --no-generator   use a hosted LLM_BASE_URL/LLM_MODEL from .env instead of MLX
 *   --restart        stop an earlier api and web first, so code changes load
 *                    (the models stay loaded)
 *   --restart=all    stop every earlier service first (models reload: slower)
 */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";

const require = createRequire(import.meta.url);
const useLocalGenerator = !process.argv.includes("--no-generator");
const restartArg = process.argv.find((arg) => arg === "--restart" || arg.startsWith("--restart="));
const restartNames = !restartArg
  ? new Set()
  : restartArg === "--restart=all"
    ? new Set(["generator", "retrieval", "api", "web"])
    : new Set(restartArg === "--restart" ? ["api", "web"] : restartArg.slice("--restart=".length).split(","));

const colors = { generator: 35, retrieval: 36, api: 33, web: 32, dev: 1 };
const log = (name, line) =>
  process.stdout.write(`\x1b[${colors[name] ?? 0}m${name.padEnd(9)}\x1b[0m | ${line}\n`);

const services = [
  ...(useLocalGenerator
    ? [{ name: "generator", script: "generator:serve", health: "http://127.0.0.1:8791/v1/models", port: 8791 }]
    : []),
  { name: "retrieval", script: "retrieval:serve", health: "http://127.0.0.1:8788/health", port: 8788 },
  {
    name: "api",
    script: useLocalGenerator ? "api:dev:local-generator" : "api:dev",
    health: "http://127.0.0.1:8787/health",
    port: 8787,
  },
  { name: "web", script: "web:dev", health: "http://127.0.0.1:3000/", port: 3000 },
];

async function healthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Process IDs listening on a port (macOS/Linux lsof). */
function listeners(port) {
  try {
    return execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })
      .split("\n")
      .map((line) => Number.parseInt(line, 10))
      .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
  } catch {
    return [];
  }
}

async function stopEarlier(service) {
  const pids = listeners(service.port);
  if (!pids.length) return;
  log("dev", `restarting ${service.name}: stopping the earlier one on port ${service.port} (pid ${pids.join(", ")})`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && (await portInUse(service.port))) await new Promise((r) => setTimeout(r, 300));
  if (await portInUse(service.port)) log("dev", `${service.name}: port ${service.port} is still in use; stop it by hand (kill ${pids.join(" ")})`);
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
  if (restartNames.has(service.name)) await stopEarlier(service);
  if (await healthy(service.health)) {
    log(
      "dev",
      `${service.name} already running at ${service.health} — reusing it` +
        (service.name === "api" && !restartNames.has("api") ? " (code changes need: npm run dev:all -- --restart)" : ""),
    );
    continue;
  }
  if (await portInUse(service.port)) {
    // Taken but not answering: an earlier run that is busy (the model writing
    // an answer, Next.js compiling). Starting a copy would only fail.
    log("dev", `${service.name}: port ${service.port} is taken by an earlier run that is busy — reusing it (restart: npm run dev:all -- --restart=${service.name})`);
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
