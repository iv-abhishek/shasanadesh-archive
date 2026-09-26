#!/usr/bin/env node
/**
 * Run a command with the repository-root .env loaded.
 *
 * Usage (from package.json): node --env-file-if-exists=.env scripts/with-env.mjs <command> [args...]
 *
 * Node parses .env (quotes, special characters in DATABASE_URL, etc.) and
 * values already exported in the shell take precedence. The Python tools
 * (embedding, retrieval service, search, inventory) inherit that environment.
 */
import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Usage: with-env.mjs <command> [args...]");
  process.exit(2);
}

const child = spawn(command, args, { stdio: "inherit", env: process.env });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`Could not start ${command}: ${error.message}`);
  process.exit(127);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
