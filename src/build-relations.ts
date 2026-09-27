/**
 * Pipeline stage: document relations (npm run relations:build)
 *
 * Purpose:
 *   For every known order, find references to earlier orders in its portal
 *   subject and its native page text (src/relations/extract.ts), and match each
 *   reference to a listed or archived order by number key + date.
 *   Output: data/corpus/relations.jsonl (derived, rebuildable); db:load copies
 *   it into document_relations (migration 008).
 *
 * Invariants:
 *   - OCR text is not used for numbers (its digits are unreliable)
 *   - an order never relates to itself; unmatched references are kept with
 *     their number/date text and targetSourceId null
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { toIsoGoDate } from "./lib/go-date.js";
import { extractReferences, goKey, type RelationKind } from "./relations/extract.js";

const root = process.cwd();
const documentsRoot = path.join(root, "data/documents");
const inventoryPath = path.join(root, "data/portal-capture/inventory.jsonl");
const outputPath = path.join(root, "data/corpus/relations.jsonl");

interface OrderInfo {
  sourceId: string;
  goNumber: string | null;
  goDate: string | null;
  subject: string | null;
  folder: string | null;
}

export interface RelationRecord {
  sourceId: string;
  sourceGoNumber: string | null;
  sourceGoDate: string | null;
  kind: RelationKind;
  targetGoNumber: string;
  targetGoKey: string;
  targetGoDate: string;
  targetSourceId: string | null;
  foundIn: string;
  evidence: string;
}

async function readJsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8")).split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T);
}

async function collectOrders(): Promise<Map<string, OrderInfo>> {
  const orders = new Map<string, OrderInfo>();
  for (const row of await readJsonl<Record<string, string | null>>(inventoryPath)) {
    orders.set(String(row.sourceId), {
      sourceId: String(row.sourceId),
      goNumber: row.goNumber ?? null,
      goDate: toIsoGoDate(row.goDate),
      subject: row.subject ?? null,
      folder: null,
    });
  }
  if (existsSync(documentsRoot)) {
    for (const entry of await readdir(documentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(documentsRoot, entry.name);
      const metadata = await readFile(path.join(folder, "metadata.json"), "utf8").then((text) => JSON.parse(text)).catch(() => null);
      if (!metadata?.sourceId) continue;
      const existing = orders.get(metadata.sourceId);
      orders.set(metadata.sourceId, {
        sourceId: metadata.sourceId,
        goNumber: existing?.goNumber ?? metadata.goNumber ?? null,
        goDate: existing?.goDate ?? toIsoGoDate(metadata.goDate),
        subject: existing?.subject ?? metadata.portal?.subject ?? metadata.title ?? null,
        folder,
      });
    }
  }
  return orders;
}

async function main(): Promise<void> {
  const orders = await collectOrders();

  // Number key + date → order, for matching references.
  const index = new Map<string, string[]>();
  for (const order of orders.values()) {
    const key = order.goNumber ? goKey(order.goNumber) : null;
    if (!key || !order.goDate) continue;
    const id = `${key}@${order.goDate}`;
    index.set(id, [...(index.get(id) ?? []), order.sourceId]);
  }

  const relations: RelationRecord[] = [];
  for (const order of orders.values()) {
    const own = { goNumber: order.goNumber, goDate: order.goDate };
    const found = new Map<string, RelationRecord>();
    const add = (text: string | null, foundIn: string) => {
      if (!text) return;
      for (const reference of extractReferences(text, own)) {
        const id = `${reference.goKey}@${reference.goDate}`;
        const candidates = (index.get(id) ?? []).filter((sourceId) => sourceId !== order.sourceId);
        const record: RelationRecord = {
          sourceId: order.sourceId,
          sourceGoNumber: order.goNumber,
          sourceGoDate: order.goDate,
          kind: reference.kind,
          targetGoNumber: reference.goNumber,
          targetGoKey: reference.goKey,
          targetGoDate: reference.goDate,
          targetSourceId: candidates.length === 1 ? candidates[0] : null,
          foundIn,
          evidence: reference.evidence.slice(0, 300),
        };
        const previous = found.get(id);
        if (!previous || (previous.kind === "refers" && record.kind !== "refers")) found.set(id, record);
      }
    };

    add(order.subject, "subject");
    if (order.folder) {
      for (const line of (await readFile(path.join(order.folder, "pages.jsonl"), "utf8").catch(() => "")).split("\n")) {
        if (!line.trim()) continue;
        const page = JSON.parse(line) as { pageNumber: number; textSource: string; text: string };
        if (page.textSource !== "native") continue;
        add(page.text, `page ${page.pageNumber}`);
      }
    }
    relations.push(...found.values());
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, relations.map((record) => JSON.stringify(record)).join("\n") + (relations.length ? "\n" : ""), "utf8");

  const byKind = new Map<string, number>();
  for (const record of relations) byKind.set(record.kind, (byKind.get(record.kind) ?? 0) + 1);
  console.log("Document relations");
  console.log("==================");
  console.log(`Orders scanned:       ${orders.size}`);
  console.log(`References found:     ${relations.length} (${[...byKind].map(([kind, n]) => `${kind} ${n}`).join(", ") || "none"})`);
  console.log(`Matched to an order:  ${relations.filter((record) => record.targetSourceId).length}`);
  console.log(`Output:               ${path.relative(root, outputPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
