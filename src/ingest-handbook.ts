/**
 * Pipeline stage: ingestion (UP Financial Handbook, HTML volumes)
 *
 * Purpose:
 *   Read the Financial Handbook volumes published as web pages on
 *   budget.up.nic.in (src/sources/up-fhb.ts) into one document per volume.
 *   Each chapter page is fetched politely, turned into text, and split into
 *   page-sized parts; every part remembers the official URL of its chapter
 *   page, so answers cite "FHB Vol. V Part I — CHAPTER X" with a link to that
 *   exact page. Usage:
 *     npm run ingest:handbook                      (all volumes not read in 30 days)
 *     npm run ingest:handbook -- --volume vol5-part1
 *     npm run ingest:handbook -- --force           (read again even if recent)
 *     npm run ingest:handbook -- --refresh-days 7
 *     npm run ingest:handbook -- --reparse         (re-read the saved pages after a
 *                                                   reader change; no network)
 *
 * Output (data/documents/<sourceId>/):
 *   metadata.json   provider "up-fhb"; pageUrls[i] = official URL of page i+1;
 *                   html.entries = the volume's chapters with their page range
 *   html-pages/page-NNN.txt   the text build:pages reads instead of a PDF
 *   raw.html.json   the fetched HTML of every chapter (also archived in B2)
 *
 * Invariants:
 *   - fetches only budget.up.nic.in through politeFetch (government host,
 *     robots.txt, crawl delay); about 600 pages take ~35 minutes
 *   - a volume is replaced only when every chapter page was read; one failed
 *     page keeps the previous capture and reports the volume as failed. A
 *     page the site answers 404 for (a dead index link) is recorded in
 *     html.skippedLinks instead.
 *   - unchanged content (same text hash) does not create a new B2 capture
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { politeFetch } from "./sources/http.js";
import {
  FHB_COLLECTION,
  FHB_HOST,
  FHB_INDEX_PAGE,
  HANDBOOK_VOLUMES,
  decodeHandbookHtml,
  handbookPageText,
  handbookVolume,
  parseHandbookIndex,
  volumeParts,
  type ChapterRead,
  type HandbookVolume,
} from "./sources/up-fhb.js";
import { isB2Enabled, storeCaptureInB2, type B2CaptureStorage } from "./storage/b2.js";

const documentsRoot = path.resolve("data/documents");
const ALLOWED_HOSTS = [FHB_HOST] as const;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

/** The site answered that the page does not exist (a dead link in its index). */
class MissingPage extends Error {}

async function fetchHtml(url: string): Promise<{ html: string; bytes: Buffer }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await politeFetch(url, { allowedHosts: ALLOWED_HOSTS, timeoutMs: 60_000 });
      if (response.status === 404 || response.status === 410) throw new MissingPage(`HTTP ${response.status}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      return { html: decodeHandbookHtml(bytes), bytes };
    } catch (error) {
      if (error instanceof MissingPage) throw error;
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt));
    }
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function readJson(file: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

async function ingestVolume(volume: HandbookVolume, force: boolean, refreshDays: number, b2: boolean, reparse: boolean): Promise<"read" | "unchanged" | "recent" | "failed"> {
  const dir = path.join(documentsRoot, volume.sourceId);
  const metadataPath = path.join(dir, "metadata.json");
  const previous = await readJson(metadataPath);
  const lastRead = Date.parse(previous?.html?.checkedAt ?? "");
  if (!force && !reparse && Number.isFinite(lastRead) && Date.now() - lastRead < refreshDays * 86_400_000) {
    console.log(`SKIP ${volume.id}: read ${previous!.html.checkedAt.slice(0, 10)} (within ${refreshDays} days; --force to read again)`);
    return "recent";
  }

  console.log(`\n${volume.id}: ${volume.title}${reparse ? " (re-reading the saved pages)" : ""}`);
  // --reparse turns the saved HTML into text again (after a reader change)
  // without fetching anything; the B2 capture stays the same.
  const saved = reparse ? await readJson(path.join(dir, "raw.html.json")) : null;
  if (reparse && (!saved?.index || !Array.isArray(saved.pages))) {
    console.error(`FAILED ${volume.id}: no saved pages to re-read; run without --reparse first.`);
    return "failed";
  }
  const indexHtml: string = saved ? String(saved.index) : (await fetchHtml(volume.indexUrl)).html;
  const { entries, skipped } = parseHandbookIndex(indexHtml, volume.indexUrl);
  if (!entries.length) {
    console.error(`FAILED ${volume.id}: the index lists no chapter pages (did the site change?)`);
    return "failed";
  }
  console.log(`  ${entries.length} chapter pages${skipped.length ? `; not readable here: ${skipped.map((item) => item.url.split("/").pop()).join(", ")}` : ""}`);

  const savedPages = new Map<string, { sha256: string; html: string }>(
    (saved?.pages ?? []).map((page: { url: string; sha256: string; html: string }) => [page.url, page]),
  );
  const chapters: ChapterRead[] = [];
  const failures: string[] = [];
  for (const [position, entry] of entries.entries()) {
    if (saved) {
      const page = savedPages.get(entry.url);
      const missing = (previous?.html?.skippedLinks ?? []).find((item: { url: string }) => item.url === entry.url);
      if (page) {
        const { heading, text } = handbookPageText(page.html);
        chapters.push({ url: entry.url, label: entry.label, heading, text, rawSha256: page.sha256, html: page.html });
      } else if (missing) {
        if (!skipped.some((item) => item.url === entry.url)) skipped.push(missing);
      } else {
        failures.push(`${entry.url}: not in the saved capture`);
      }
      continue;
    }
    try {
      const page = await fetchHtml(entry.url);
      const { heading, text } = handbookPageText(page.html);
      chapters.push({ url: entry.url, label: entry.label, heading, text, rawSha256: sha256(page.bytes), html: page.html });
      if ((position + 1) % 25 === 0) console.log(`  ${position + 1}/${entries.length} pages read`);
    } catch (error) {
      if (error instanceof MissingPage) {
        // A dead link in the official index (e.g. Vol. V Part II "030.HMT")
        // is recorded, not treated as a failed read.
        skipped.push({ url: entry.url, label: entry.label, reason: `${error.message} on the official site` });
        console.warn(`  missing on the site: ${entry.url} (${entry.label || "no label"})`);
        continue;
      }
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length) {
    console.error(`FAILED ${volume.id}: ${failures.length} of ${entries.length} pages could not be read; the previous capture is kept.`);
    for (const failure of failures.slice(0, 5)) console.error(`  ${failure}`);
    return "failed";
  }

  const { parts, entries: chapterPages } = volumeParts(volume, chapters);
  const contentSha256 = sha256(parts.map((part) => `${part.url}\n${part.text}`).join("\n\f\n"));
  const checkedAt = new Date().toISOString();

  if (previous?.html?.contentSha256 === contentSha256) {
    previous.html.checkedAt = checkedAt;
    await writeFile(metadataPath, JSON.stringify(previous, null, 2) + "\n", "utf8");
    console.log(`UNCHANGED ${volume.id}: ${parts.length} pages, same text as ${String(previous.capture?.downloadedAt ?? "").slice(0, 10)}`);
    return "unchanged";
  }

  // Write the new capture beside the old one, then swap, so a crash never
  // leaves a half-written volume.
  const staging = `${dir}.new`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, "html-pages"), { recursive: true });
  for (const [index, part] of parts.entries()) {
    await writeFile(path.join(staging, "html-pages", `page-${String(index + 1).padStart(3, "0")}.txt`), part.text + "\n", "utf8");
  }
  const rawBundle = saved
    ? await readFile(path.join(dir, "raw.html.json"))
    : Buffer.from(
    JSON.stringify(
      {
        volume: volume.sourceId,
        indexUrl: volume.indexUrl,
        fetchedAt: checkedAt,
        index: indexHtml,
        pages: chapters.map((chapter) => ({ url: chapter.url, sha256: chapter.rawSha256, html: chapter.html })),
      },
      null,
      1,
    ) + "\n",
    "utf8",
  );
  await writeFile(path.join(staging, "raw.html.json"), rawBundle);

  const textBytes = parts.reduce((sum, part) => sum + Buffer.byteLength(part.text, "utf8"), 0);
  const metadata: Record<string, unknown> = {
    provider: FHB_COLLECTION,
    sourceId: volume.sourceId,
    title: volume.title,
    titles: { en: volume.title, hi: volume.titleHi },
    issuer: "Finance Department, Government of Uttar Pradesh",
    jurisdiction: "state",
    department: "वित्त विभाग",
    documentType: "rules",
    goDate: null,
    goNumber: null,
    language: "en",
    sourceUrl: volume.indexUrl,
    evidenceUrl: volume.indexUrl,
    listingUrls: [FHB_INDEX_PAGE],
    verificationStatus: "downloaded",
    // Official URL of each page (index i = page i+1); citations use these.
    pageUrls: parts.map((part) => part.url),
    sourceRecord: { topics: volume.topics, scope: volume.scope, edition: "Online edition on budget.up.nic.in" },
    html: {
      pages: parts.length,
      chapters: chapterPages,
      skippedLinks: skipped,
      contentSha256,
      checkedAt,
    },
    capture: saved && previous?.capture ? previous.capture : {
      method: "html-crawl",
      status: 200,
      contentType: "text/html (one JSON bundle of the chapter pages)",
      captureId: randomUUID(),
      downloadedAt: checkedAt,
      bytes: rawBundle.byteLength,
      rawSha256: sha256(rawBundle),
    },
    text: { bytes: textBytes, hasNativeText: true },
  };

  if (saved && previous?.storage) {
    // Same raw pages: keep the existing B2 capture; its manifest is refreshed
    // when build:pages saves the metadata.
    metadata.storage = previous.storage;
  } else if (b2) {
    const capture = metadata.capture as Record<string, string>;
    const storage: B2CaptureStorage = await storeCaptureInB2({
      collection: FHB_COLLECTION,
      sourceId: volume.sourceId,
      captureId: capture.captureId,
      pdf: rawBundle,
      metadata,
      rawExtension: "html.json",
      rawContentType: "application/json",
    });
    metadata.storage = storage;
  }
  await writeFile(path.join(staging, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n", "utf8");

  await rm(`${dir}.old`, { recursive: true, force: true });
  if (previous) await rename(dir, `${dir}.old`);
  await rename(staging, dir);
  await rm(`${dir}.old`, { recursive: true, force: true });
  console.log(`OK ${volume.id}: ${chapters.length} chapter pages → ${parts.length} pages, ${(textBytes / 1000).toFixed(0)} kB text${b2 ? ", archived in B2" : " (B2 not configured: local only)"}`);
  return "read";
}

async function main(): Promise<void> {
  const only = option("--volume");
  const refreshDays = Number(option("--refresh-days") ?? 30);
  if (!Number.isFinite(refreshDays) || refreshDays < 0) throw new Error("--refresh-days must be a number of days.");
  const force = process.argv.includes("--force");
  const reparse = process.argv.includes("--reparse");
  const volumes = only ? [handbookVolume(only)] : [...HANDBOOK_VOLUMES];
  const b2 = isB2Enabled();
  await mkdir(documentsRoot, { recursive: true });

  const totals: Record<string, number> = { read: 0, unchanged: 0, recent: 0, failed: 0 };
  for (const volume of volumes) {
    try {
      totals[await ingestVolume(volume, force, refreshDays, b2, reparse)]++;
    } catch (error) {
      totals.failed++;
      console.error(`FAILED ${volume.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\nFinancial Handbook: ${totals.read} read, ${totals.unchanged} unchanged, ${totals.recent} recent (skipped), ${totals.failed} failed.`);
  if (totals.read) console.log("Next: npm run build:pages, then the usual build and db:load steps (or npm run sync:daily).");
  if (totals.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Financial Handbook ingestion stopped:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
