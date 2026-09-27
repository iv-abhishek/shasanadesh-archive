/**
 * Local disk policy (ADR-056): B2 is the archive, the Mac keeps a working cache.
 *
 *   - Every original is in B2 (sha256 recorded in metadata.storage.raw).
 *   - Locally we keep metadata + extracted text for every order, and the
 *     original PDF only for orders that are processed (tier A/B or unsure).
 *   - OCR page images are deleted as soon as their text is written.
 *   - Importers stop before free space falls below MIN_FREE_DISK_GB (default 40).
 *   - An order that becomes useful later (tier corrected to A/B) gets its
 *     original back with `npm run storage:restore -- --needed`.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { promisify } from "node:util";
import type { B2CaptureStorage } from "./b2.js";

const GB = 1e9;

export function minFreeBytes(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.MIN_FREE_DISK_GB);
  return (Number.isFinite(value) && value >= 0 ? value : 40) * GB;
}

/**
 * Free space for unprivileged writes. POSIX `df -Pk` reports 1024-byte blocks on
 * macOS and Linux alike; statfs's bsize is not the block unit on every Linux
 * filesystem, so it is only the fallback.
 */
export async function freeBytes(dir: string): Promise<number> {
  try {
    const { stdout } = await promisify(execFile)("df", ["-Pk", dir]);
    const available = Number(stdout.trim().split("\n").at(-1)?.trim().split(/\s+/)[3]);
    if (Number.isFinite(available)) return available * 1024;
  } catch {
    // fall through
  }
  const stats = await statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

export const formatGb = (bytes: number) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;

/**
 * Null when there is room; otherwise a message saying why an importer stops.
 * Importers call this before each download.
 */
export async function diskSpaceProblem(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const free = await freeBytes(dir);
  const floor = minFreeBytes(env);
  if (free >= floor) return null;
  return (
    `Stopping: only ${formatGb(free)} free on this disk (floor MIN_FREE_DISK_GB=${formatGb(floor)}). ` +
    "Run `npm run storage:trim -- --apply` to drop local copies that are safe in B2, or raise/lower the floor."
  );
}

export interface LocalCopyState {
  state: "evicted";
  reason: string;
  at: string;
}

/**
 * True when the local original may be deleted: B2 holds an object with the
 * same SHA-256 as the local bytes, in the configured bucket.
 */
export function sameAsB2(
  storage: B2CaptureStorage | undefined,
  localBytes: Buffer,
  bucket = process.env.B2_BUCKET?.trim() || process.env.B2_BUCKET_NAME?.trim(),
): boolean {
  if (storage?.provider !== "backblaze-b2-native" || !storage.raw?.fileId || !storage.raw.sha256) return false;
  if (bucket && storage.bucket !== bucket) return false;
  return createHash("sha256").update(localBytes).digest("hex") === storage.raw.sha256;
}

export async function readIfExists(file: string): Promise<Buffer | null> {
  return readFile(file).catch(() => null);
}

/** Average bytes per order → projected bytes for `total` orders with the given tier shares. */
export function projectBytes(
  perOrder: Record<string, number>,
  shares: Record<string, number>,
  total: number,
): number {
  let bytes = 0;
  for (const [tier, share] of Object.entries(shares)) bytes += (perOrder[tier] ?? perOrder.all ?? 0) * share * total;
  return bytes;
}
