/**
 * Pipeline stage: classification (npm run classify:orders)
 *
 * Purpose:
 *   Give every known order a document type and a tier (docs/ROADMAP.md §4)
 *   from its listing metadata, before any heavy processing:
 *     - portal listings in data/portal-capture/inventory.jsonl (also orders not
 *       downloaded yet), and
 *     - captured documents in data/documents/<id>/metadata.json.
 *   Precedence: human correction (datasets/classification-overrides.jsonl) >
 *   model pass for low-confidence orders (data/corpus/classification-model.jsonl,
 *   npm run classify:model) > rules.
 *
 * Output:
 *   data/corpus/classification.jsonl — one line per sourceId (derived, rebuildable);
 *   db:load copies it into documents.doc_type / tier / classification.
 *
 * Invariants:
 *   - read-only for source data; only the output file is written
 *   - an override always wins over rules and records who/why
 *
 * Usage: npm run classify:orders [-- --samples 5]
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RULES_VERSION, classifyOrder, normalizeSubject, type Classification, type DocType, type Tier } from "./classify/rules.js";
import { topicsFor, type TopicCode } from "./classify/topics.js";

const root = process.cwd();
const inventoryPath = path.join(root, "data/portal-capture/inventory.jsonl");
const documentsRoot = path.join(root, "data/documents");
const overridesPath = path.join(root, "datasets/classification-overrides.jsonl");
const outputPath = path.join(root, "data/corpus/classification.jsonl");
const modelPath = path.join(root, "data/corpus/classification-model.jsonl");

interface Candidate {
  sourceId: string;
  provider: string;
  subject: string | null;
  category: string | null;
  section: string | null;
  department: string | null;
  inListing: boolean;
  captured: boolean;
  /** Core-rules catalogue topics (ADR-062/064). */
  catalogueTopics?: string[];
}

export interface ClassificationRecord extends Classification {
  sourceId: string;
  provider: string;
  department: string | null;
  subject: string | null;
  inListing: boolean;
  captured: boolean;
  override?: { tier: Tier; docType?: DocType; note?: string; reviewedBy?: string; reviewedAt?: string };
  /** Which pass decided the tier. */
  decidedBy: "rules" | "model" | "override";
  modelReason?: string;
  /** Topic groups (src/classify/topics.ts, ADR-064). */
  topics: TopicCode[];
  classifiedAt: string;
}

async function readJsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? normalizeSubject(value) : null);

async function collect(): Promise<Map<string, Candidate>> {
  const candidates = new Map<string, Candidate>();

  for (const row of await readJsonl<Record<string, unknown>>(inventoryPath)) {
    const sourceId = String(row.sourceId);
    candidates.set(sourceId, {
      sourceId,
      provider: "shasanadesh-up",
      subject: text(row.subject),
      category: text(row.category),
      section: text(row.section),
      department: text(row.department),
      inListing: true,
      captured: false,
    });
  }

  if (existsSync(documentsRoot)) {
    for (const entry of await readdir(documentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(documentsRoot, entry.name, "metadata.json");
      if (!existsSync(file)) continue;
      const metadata = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
      const sourceId = String(metadata.sourceId ?? "");
      if (!sourceId) continue;
      const portal = (metadata.portal ?? {}) as Record<string, unknown>;
      const existing = candidates.get(sourceId);
      candidates.set(sourceId, {
        sourceId,
        provider: String(metadata.provider ?? "shasanadesh-up"),
        subject: existing?.subject ?? text(portal.subject) ?? text(metadata.title),
        category: existing?.category ?? text(portal.category) ?? text(metadata.documentType),
        section: existing?.section ?? text(portal.section),
        department: existing?.department ?? text(metadata.department),
        inListing: Boolean(existing),
        captured: true,
        catalogueTopics: Array.isArray(metadata.sourceRecord?.topics) ? metadata.sourceRecord.topics : undefined,
      });
    }
  }

  return candidates;
}

async function main(): Promise<void> {
  const samplesIndex = process.argv.indexOf("--samples");
  const samples = samplesIndex >= 0 ? Number(process.argv[samplesIndex + 1] ?? 5) : 0;

  const candidates = await collect();
  const overrides = new Map(
    (await readJsonl<{ sourceId: string; tier: Tier; docType?: DocType; note?: string; reviewedBy?: string; reviewedAt?: string }>(overridesPath))
      .map((item) => [item.sourceId, item]),
  );

  const modelResults = new Map(
    (await readJsonl<{ sourceId: string; tier: Tier; docType: DocType; reason: string; rulesVersion: string }>(modelPath))
      .filter((item) => item.rulesVersion === RULES_VERSION)
      .map((item) => [item.sourceId, item]),
  );

  const classifiedAt = new Date().toISOString();
  const records: ClassificationRecord[] = [];
  for (const candidate of candidates.values()) {
    const rules = classifyOrder(candidate);
    const override = overrides.get(candidate.sourceId);
    const model = rules.confidence === "low" ? modelResults.get(candidate.sourceId) : undefined;
    records.push({
      sourceId: candidate.sourceId,
      provider: candidate.provider,
      department: candidate.department,
      subject: candidate.subject,
      inListing: candidate.inListing,
      captured: candidate.captured,
      ...rules,
      topics: topicsFor(candidate),
      decidedBy: "rules" as const,
      ...(model
        ? {
            tier: model.tier,
            docType: model.docType,
            confidence: "high" as const,
            decidedBy: "model" as const,
            modelReason: model.reason,
          }
        : {}),
      ...(override
        ? {
            tier: override.tier,
            docType: override.docType ?? rules.docType,
            confidence: "high" as const,
            decidedBy: "override" as const,
            override,
          }
        : {}),
      classifiedAt,
    });
  }
  records.sort((a, b) => a.sourceId.localeCompare(b.sourceId));

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

  const count = (predicate: (record: ClassificationRecord) => boolean) => records.filter(predicate).length;
  const byType = new Map<string, number>();
  for (const record of records) byType.set(record.docType, (byType.get(record.docType) ?? 0) + 1);

  console.log("Order classification");
  console.log("====================");
  console.log(`Orders:           ${records.length} (listed ${count((r) => r.inListing)}, captured ${count((r) => r.captured)})`);
  console.log(`Tier A:           ${count((r) => r.tier === "A")}  generally applicable`);
  console.log(`Tier B:           ${count((r) => r.tier === "B")}  useful in context`);
  console.log(`Tier C:           ${count((r) => r.tier === "C")}  routine or individual`);
  console.log(`Low confidence:   ${count((r) => r.confidence === "low")}  (for model pass / review)`);
  console.log(`Decided by model: ${count((r) => r.decidedBy === "model")}`);
  console.log(`Overrides:        ${count((r) => Boolean(r.override))}`);
  const byTopic = new Map<string, number>();
  for (const record of records) for (const topic of record.topics) byTopic.set(topic, (byTopic.get(topic) ?? 0) + 1);
  console.log("By topic:         " + [...byTopic].sort((a, b) => b[1] - a[1]).map(([topic, n]) => `${topic} ${n}`).join(", "));
  console.log("By type:          " + [...byType].sort((a, b) => b[1] - a[1]).map(([type, n]) => `${type} ${n}`).join(", "));
  console.log(`Output:           ${path.relative(root, outputPath)}`);

  if (samples > 0) {
    for (const [type] of [...byType].sort((a, b) => b[1] - a[1])) {
      console.log(`\n--- ${type}`);
      for (const record of records.filter((r) => r.docType === type).slice(0, samples)) {
        console.log(`  ${record.tier} ${record.confidence.padEnd(4)} ${record.sourceId.padEnd(18)} ${(record.subject ?? "(no subject)").slice(0, 110)}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
