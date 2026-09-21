/**
 * Shasanadesh Archive — documented pipeline file
 *
 * Pipeline stage: diagnostics
 * Purpose: Run small capped sequence-neighborhood diagnostics; not a bulk discovery crawler.
 *
 * Invariants:
 * - preserve source provenance and stable source/page identifiers
 * - keep raw/native/OCR variants auditable instead of silently overwriting evidence
 * - keep parameters explicit and documented when they affect corpus/search quality
 *
 * Project hand-off docs:
 * - docs/PROJECT_MEMORY.md
 * - docs/ARCHITECTURE.md
 * - docs/CONFIGURATION.md
 * - docs/DECISIONS.md
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildShasanadeshPdfUrl,
  encodeShasanadeshId,
} from "./lib/shasanadesh-id.js";

interface ProbeResult {
  sourceId: string;
  encodedId: string;
  url: string;
  status?: number;
  contentType?: string | null;
  bytes?: number;
  isPdf: boolean;
  classification: "pdf" | "empty-html" | "html" | "error";
  rawSha256?: string;
  savedPath?: string;
  htmlPreview?: string;
  error?: string;
}

function arg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);

  if (index === -1) {
    return fallback;
  }

  return process.argv[index + 1];
}

function intArg(name: string, fallback?: number): number {
  const raw = arg(name, fallback === undefined ? undefined : String(fallback));

  if (raw === undefined) {
    throw new Error(`Missing --${name}`);
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isInteger(value)) {
    throw new Error(`Invalid --${name}: ${raw}`);
  }

  return value;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

function classifyHtml(buffer: Buffer): "empty-html" | "html" {
  const text = buffer.toString("utf8");

  const looksLikeEmptyViewer =
    text.includes('id="form1"') &&
    text.includes("__VIEWSTATE") &&
    !text.toLowerCase().includes("<iframe") &&
    !text.toLowerCase().includes("<embed") &&
    !text.toLowerCase().includes("<object");

  return looksLikeEmptyViewer ? "empty-html" : "html";
}

async function probeOne(
  sequence: number,
  departmentId: number,
  sectionId: number,
  year: number,
  outputDir: string,
): Promise<ProbeResult> {
  const sourceId = `${sequence}#${departmentId}#${sectionId}#${year}`;
  const encodedId = encodeShasanadeshId({
    sequence,
    departmentId,
    sectionId,
    year,
  });

  const url = buildShasanadeshPdfUrl(encodedId);

  console.log("\n--------------------------------");
  console.log(`Source ID: ${sourceId}`);
  console.log(`URL:       ${url}`);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        Accept: "application/pdf,text/html;q=0.9,*/*;q=0.8",
        "Accept-Language": "hi-IN,hi;q=0.9,en-IN;q=0.8,en;q=0.7",
      },
      signal: AbortSignal.timeout(60_000),
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    const pdf = response.ok && looksLikePdf(buffer);
    const contentType = response.headers.get("content-type");

    console.log(`Status:       ${response.status}`);
    console.log(`Content-Type: ${contentType}`);
    console.log(`Bytes:        ${buffer.length}`);
    console.log(`PDF:          ${pdf ? "YES" : "NO"}`);

    if (pdf) {
      const filename = `${sourceId.replaceAll("#", "-")}.pdf`;
      const savedPath = path.join(outputDir, filename);

      await writeFile(savedPath, buffer);

      console.log(`FOUND PDF:    ${savedPath}`);

      return {
        sourceId,
        encodedId,
        url,
        status: response.status,
        contentType,
        bytes: buffer.length,
        isPdf: true,
        classification: "pdf",
        rawSha256: sha256(buffer),
        savedPath,
      };
    }

    const classification = classifyHtml(buffer);
    const htmlPreview = buffer
      .toString("utf8")
      .replace(/\s+/g, " ")
      .slice(0, 240);

    console.log(`Classification: ${classification}`);

    return {
      sourceId,
      encodedId,
      url,
      status: response.status,
      contentType,
      bytes: buffer.length,
      isPdf: false,
      classification,
      htmlPreview,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);

    return {
      sourceId,
      encodedId,
      url,
      isPdf: false,
      classification: "error",
      error: message,
    };
  }
}

async function main() {
  const departmentId = intArg("department");
  const sectionId = intArg("section");
  const year = intArg("year");
  const from = intArg("from");
  const to = intArg("to");
  const delayMs = intArg("delay", 5000);

  if (from < 1 || to < from) {
    throw new Error("Require 1 <= --from <= --to");
  }

  const requestCount = to - from + 1;

  // Safety guard: this tool is intentionally for small, cautious experiments.
  if (requestCount > 25) {
    throw new Error(
      `Refusing ${requestCount} requests in one run. Maximum is 25.`,
    );
  }

  if (delayMs < 3000) {
    throw new Error("Minimum --delay is 3000 ms.");
  }

  const runName = `${departmentId}-${sectionId}-${year}-${from}-${to}`;
  const outputDir = path.resolve("data/probes", runName);
  const reportPath = path.join(outputDir, "report.json");

  await mkdir(outputDir, { recursive: true });

  console.log("Shasanadesh neighborhood probe");
  console.log("==============================");
  console.log(`Department: ${departmentId}`);
  console.log(`Section:    ${sectionId}`);
  console.log(`Year:       ${year}`);
  console.log(`Sequence:   ${from}..${to}`);
  console.log(`Requests:   ${requestCount}`);
  console.log(`Delay:      ${delayMs} ms`);

  const results: ProbeResult[] = [];

  for (let sequence = from; sequence <= to; sequence++) {
    results.push(
      await probeOne(sequence, departmentId, sectionId, year, outputDir),
    );

    if (sequence < to) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  await writeFile(reportPath, JSON.stringify(results, null, 2) + "\n");

  const pdfs = results.filter((result) => result.classification === "pdf");
  const emptyHtml = results.filter(
    (result) => result.classification === "empty-html",
  );
  const other = results.length - pdfs.length - emptyHtml.length;

  console.log("\n================================");
  console.log("Probe summary");
  console.log("================================");
  console.log(`Attempted:  ${results.length}`);
  console.log(`PDFs found: ${pdfs.length}`);
  console.log(`Empty HTML: ${emptyHtml.length}`);
  console.log(`Other:      ${other}`);
  console.log(`Report:     ${reportPath}`);

  if (pdfs.length > 0) {
    console.log("\nValid source IDs:");
    for (const result of pdfs) {
      console.log(`  ${result.sourceId}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
