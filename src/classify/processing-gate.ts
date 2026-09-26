/**
 * "Classify first, process second" (docs/ROADMAP.md §4).
 *
 * Heavy steps — full OCR (ocr:needs), selective OCR (compare:suspicious) and
 * chunking for embeddings (build:retrieval-variant-chunks) — skip orders the
 * classifier is confident are routine or individual (tier C, high confidence).
 * Their PDFs and metadata stay archived and browsable; pass --include-routine
 * to process them anyway. Without data/corpus/classification.jsonl nothing is
 * skipped.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ProcessingGate {
  /** True when this order should be skipped by heavy processing steps. */
  skips(sourceId: string): boolean;
  /** How many orders the gate would skip. */
  size: number;
  enabled: boolean;
}

export function loadProcessingGate(argv: string[] = process.argv): ProcessingGate {
  const file = path.resolve("data/corpus/classification.jsonl");
  if (argv.includes("--include-routine") || !existsSync(file)) {
    return { skips: () => false, size: 0, enabled: false };
  }

  const routine = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { sourceId: string; tier: string; confidence: string };
    if (record.tier === "C" && record.confidence === "high") routine.add(record.sourceId);
  }

  return { skips: (sourceId) => routine.has(sourceId), size: routine.size, enabled: true };
}

/** One summary line for the console. */
export function describeGate(gate: ProcessingGate, skipped: number): string {
  return gate.enabled
    ? `Routine orders skipped: ${skipped} (tier C; --include-routine to process them)`
    : "Routine orders skipped: 0 (no classification yet or --include-routine)";
}
