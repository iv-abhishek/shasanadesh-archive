/**
 * Local disk management (ADR-056).
 *
 *   npm run storage:report                 what is on disk, by tier, and the projection for the full portal
 *   npm run storage:trim [-- --apply]      delete what B2 already holds and nothing needs locally
 *                                          (dry run unless --apply)
 *   npm run storage:restore -- --needed    bring back originals of orders that are processed again
 *   npm run storage:restore -- --source-id <id>
 *
 * trim removes:
 *   - OCR page images (ocr-pages/*.png) once that order's OCR is complete;
 *   - original.pdf of orders the processing gate skips (tier C, high confidence),
 *     only after the local bytes match the SHA-256 recorded for the B2 copy.
 * Metadata, extracted text, pages and chunks always stay.
 */

import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProcessingGate } from "./classify/processing-gate.js";
import { downloadFromB2, isB2Enabled, type B2CaptureStorage } from "./storage/b2.js";
import { formatGb, freeBytes, minFreeBytes, projectBytes, readIfExists, sameAsB2, type LocalCopyState } from "./storage/local-disk.js";

const root = process.cwd();
const documentsRoot = path.join(root, "data/documents");
const args = process.argv.slice(2);
const command = args[0] ?? "report";
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const PORTAL_TOTAL = Number(option("--portal-total") ?? 177_504);

interface Doc {
  dir: string;
  metadataPath: string;
  metadata: {
    sourceId: string;
    storage?: B2CaptureStorage;
    ocr?: { completed?: boolean };
    localCopy?: LocalCopyState;
    [key: string]: unknown;
  };
}

async function* documents(): AsyncGenerator<Doc> {
  for (const entry of await readdir(documentsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(documentsRoot, entry.name);
    const metadataPath = path.join(dir, "metadata.json");
    const metadata = await readFile(metadataPath, "utf8").then((text) => JSON.parse(text)).catch(() => null);
    if (metadata?.sourceId) yield { dir, metadataPath, metadata };
  }
}

async function tiers(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const text = await readFile(path.join(root, "data/corpus/classification.jsonl"), "utf8").catch(() => "");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { sourceId: string; tier: string };
    map.set(record.sourceId, record.tier);
  }
  return map;
}

/** Sizes of one order folder: original, OCR images, everything else. */
async function sizes(dir: string): Promise<{ original: number; images: number; other: number }> {
  const result = { original: 0, images: 0, other: 0 };
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      const bytes = (await stat(file)).size;
      if (current === dir && entry.name === "original.pdf") result.original += bytes;
      else if (path.basename(current) === "ocr-pages" && entry.name.endsWith(".png")) result.images += bytes;
      else result.other += bytes;
    }
  };
  await walk(dir);
  return result;
}

const writeMetadata = (doc: Doc) => writeFile(doc.metadataPath, JSON.stringify(doc.metadata, null, 2) + "\n", "utf8");

async function report(): Promise<void> {
  const tierOf = await tiers();
  const gate = loadProcessingGate([]);
  const byTier = new Map<string, { orders: number; original: number; images: number; other: number; evicted: number; kept: number }>();
  for await (const doc of documents()) {
    const tier = tierOf.get(doc.metadata.sourceId) ?? "unclassified";
    const row = byTier.get(tier) ?? { orders: 0, original: 0, images: 0, other: 0, evicted: 0, kept: 0 };
    const size = await sizes(doc.dir);
    row.orders++;
    row.original += size.original;
    row.images += size.images;
    row.other += size.other;
    if (!size.original && doc.metadata.localCopy?.state === "evicted") row.evicted++;
    // "kept" = the policy keeps the original of this order (it is processed).
    if (!gate.skips(doc.metadata.sourceId)) row.kept++;
    byTier.set(tier, row);
  }

  const mb = (bytes: number) => `${(bytes / 1e6).toFixed(0)} MB`;
  console.log("Local storage (data/documents)");
  console.log("==============================");
  console.log("Tier          Orders   Originals    OCR images   Text/pages   Originals evicted");
  let total = 0;
  const afterTrimPerOrder: Record<string, number> = {};
  const listedShares: Record<string, number> = {};
  for (const [tier, row] of [...byTier].sort()) {
    total += row.original + row.images + row.other;
    console.log(
      `${tier.padEnd(12)} ${String(row.orders).padStart(7)} ${mb(row.original).padStart(11)} ${mb(row.images).padStart(13)} ${mb(row.other).padStart(12)} ${String(row.evicted).padStart(18)}`,
    );
    // After trim: no OCR images; originals only for orders the policy keeps.
    const originalPerKept = row.original / Math.max(1, row.orders - row.evicted);
    afterTrimPerOrder[tier] = (row.other + originalPerKept * row.kept) / row.orders;
  }
  console.log(`Total: ${mb(total)}`);

  for (const tier of tierOf.values()) listedShares[tier] = (listedShares[tier] ?? 0) + 1;
  const listed = [...tierOf.values()].length || 1;
  for (const tier of Object.keys(listedShares)) listedShares[tier] /= listed;
  const projected = projectBytes(afterTrimPerOrder, listedShares, PORTAL_TOTAL);
  const free = await freeBytes(root);
  console.log("");
  console.log(`Free on this disk:        ${formatGb(free)} (importers stop at ${formatGb(minFreeBytes())}, MIN_FREE_DISK_GB)`);
  console.log(
    `Full portal, this policy: ≈ ${formatGb(projected)} for ${PORTAL_TOTAL.toLocaleString("en-IN")} orders ` +
      `(tier mix of ${listed.toLocaleString("en-IN")} classified listings: ` +
      Object.entries(listedShares).sort().map(([tier, share]) => `${tier} ${(share * 100).toFixed(0)}%`).join(", ") + ")",
  );
  console.log("                          + Postgres (text, chunks, embeddings of tier A/B), a few GB.");
  console.log("Run `npm run storage:trim` to see what can be freed now.");
}

async function trim(apply: boolean): Promise<void> {
  const gate = loadProcessingGate([]);
  let images = 0, imageBytes = 0, originals = 0, originalBytes = 0, unverified = 0;
  for await (const doc of documents()) {
    // 1. OCR page images: text is written, images are never read again.
    if (doc.metadata.ocr?.completed) {
      const pagesDir = path.join(doc.dir, "ocr-pages");
      for (const name of await readdir(pagesDir).catch(() => [] as string[])) {
        if (!name.endsWith(".png")) continue;
        const file = path.join(pagesDir, name);
        imageBytes += (await stat(file)).size;
        images++;
        if (apply) await rm(file, { force: true });
      }
    }

    // 2. Originals of routine orders, only when B2 holds the same bytes.
    if (!gate.skips(doc.metadata.sourceId)) continue;
    const pdfPath = path.join(doc.dir, "original.pdf");
    const bytes = await readIfExists(pdfPath);
    if (!bytes) continue;
    if (!sameAsB2(doc.metadata.storage, bytes)) {
      unverified++;
      continue;
    }
    originals++;
    originalBytes += bytes.length;
    if (apply) {
      await rm(pdfPath, { force: true });
      doc.metadata.localCopy = { state: "evicted", reason: "routine order; original kept in B2 (storage:trim)", at: new Date().toISOString() };
      await writeMetadata(doc);
    }
  }

  const verb = apply ? "Deleted" : "Would delete";
  console.log(`${verb} ${images} OCR page images (${(imageBytes / 1e6).toFixed(0)} MB)`);
  console.log(`${verb} ${originals} routine originals that match B2 (${(originalBytes / 1e6).toFixed(0)} MB)`);
  if (unverified) console.log(`Kept ${unverified} routine originals without a matching B2 copy (run ingest to back them up first).`);
  if (!apply) console.log("Dry run. Add `-- --apply` to delete.");
}

async function restore(): Promise<void> {
  if (!isB2Enabled()) throw new Error("B2 is not configured; nothing can be restored.");
  const sourceId = option("--source-id");
  const needed = args.includes("--needed");
  if (!sourceId && !needed) throw new Error("Use --source-id <id> or --needed.");
  const gate = loadProcessingGate([]);
  let restored = 0, failed = 0;
  for await (const doc of documents()) {
    if (sourceId ? doc.metadata.sourceId !== sourceId : gate.skips(doc.metadata.sourceId)) continue;
    const pdfPath = path.join(doc.dir, "original.pdf");
    if (await readIfExists(pdfPath)) continue;
    const raw = doc.metadata.storage?.raw;
    if (!raw?.fileId) {
      console.error(`No B2 copy recorded for ${doc.metadata.sourceId}.`);
      failed++;
      continue;
    }
    try {
      await writeFile(pdfPath, await downloadFromB2(raw));
      delete doc.metadata.localCopy;
      await writeMetadata(doc);
      restored++;
      console.log(`Restored ${doc.metadata.sourceId}`);
    } catch (error) {
      failed++;
      console.error(`FAILED ${doc.metadata.sourceId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`Restored ${restored} originals from B2${failed ? `, ${failed} failed` : ""}.`);
  if (failed) process.exitCode = 1;
}

const commands: Record<string, () => Promise<void>> = {
  report,
  trim: () => trim(args.includes("--apply")),
  restore,
};

if (!commands[command]) {
  console.error(`Unknown command "${command}". Use report, trim or restore.`);
  process.exit(1);
}
commands[command]().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
