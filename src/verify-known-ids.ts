/**
 * Shasanadesh Archive — documented pipeline file
 *
 * Pipeline stage: verification
 * Purpose: Verify public-reference IDs against the direct document endpoint.
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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildShasanadeshPdfUrl,
  decodeShasanadeshId,
} from "./lib/shasanadesh-id.js";

interface KnownId {
  encodedId: string;
  decodedId: string;
  department: string | null;
  goDate: string | null;
  goNumber: string | null;
  verificationStatus: "downloaded" | "public-reference";
  evidenceUrl: string;
}

interface VerificationResult {
  decodedId: string;
  encodedId: string;
  department: string | null;
  url: string;
  status?: number;
  contentType?: string | null;
  bytes?: number;
  rawSha256?: string;
  isPdf: boolean;
  savedPath?: string;
  error?: string;
}

const datasetPath = path.resolve("datasets/known-ids.json");
const outputDir = path.resolve("data/known-id-verification");
const reportPath = path.resolve("data/known-id-verification/report.json");

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

function safeFileName(decodedId: string): string {
  return decodedId.replaceAll("#", "-");
}

async function verify(record: KnownId): Promise<VerificationResult> {
  const decoded = decodeShasanadeshId(record.encodedId);

  if (decoded.decodedId !== record.decodedId) {
    return {
      decodedId: record.decodedId,
      encodedId: record.encodedId,
      department: record.department,
      url: "",
      isPdf: false,
      error: `Dataset mismatch: decoded to ${decoded.decodedId}`,
    };
  }

  const url = buildShasanadeshPdfUrl(decoded.base64);

  console.log("\n--------------------------------");
  console.log(`Source ID:  ${record.decodedId}`);
  console.log(`Department: ${record.department ?? "(unknown)"}`);
  console.log(`URL:        ${url}`);

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
    const pdf = isPdf(buffer);
    const hash = sha256(buffer);

    console.log(`Status:       ${response.status}`);
    console.log(`Content-Type: ${response.headers.get("content-type")}`);
    console.log(`Bytes:        ${buffer.length}`);
    console.log(`PDF:          ${pdf ? "YES" : "NO"}`);

    let savedPath: string | undefined;

    if (response.ok && pdf) {
      const filename = `${safeFileName(record.decodedId)}.pdf`;
      savedPath = path.join(outputDir, filename);
      await writeFile(savedPath, buffer);
      console.log(`Saved:        ${savedPath}`);
    }

    return {
      decodedId: record.decodedId,
      encodedId: record.encodedId,
      department: record.department,
      url,
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: buffer.length,
      rawSha256: hash,
      isPdf: response.ok && pdf,
      savedPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);

    return {
      decodedId: record.decodedId,
      encodedId: record.encodedId,
      department: record.department,
      url,
      isPdf: false,
      error: message,
    };
  }
}

async function main() {
  await mkdir(outputDir, { recursive: true });

  const raw = await readFile(datasetPath, "utf8");
  const records = JSON.parse(raw) as KnownId[];

  // Only verify IDs we have not directly tested yet.
  const candidates = records.filter(
    (record) => record.verificationStatus === "public-reference",
  );

  console.log(`Known records: ${records.length}`);
  console.log(`To verify:     ${candidates.length}`);

  const results: VerificationResult[] = [];

  for (const record of candidates) {
    results.push(await verify(record));

    // Be conservative with the government server.
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  await writeFile(reportPath, JSON.stringify(results, null, 2) + "\n");

  const successful = results.filter((result) => result.isPdf);

  console.log("\n================================");
  console.log("Verification summary");
  console.log("================================");
  console.log(`Attempted: ${results.length}`);
  console.log(`PDFs:      ${successful.length}`);
  console.log(`Failed:    ${results.length - successful.length}`);
  console.log(`Report:    ${reportPath}`);

  if (successful.length !== results.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
