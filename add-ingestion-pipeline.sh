#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f package.json ]]; then
  echo "Run this from the shasanadesh project root."
  exit 1
fi

mkdir -p src

cat > src/promote-probe-results.ts <<'EOF'
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeShasanadeshId } from "./lib/shasanadesh-id.js";

interface KnownId {
  encodedId: string;
  decodedId: string;
  department: string | null;
  goDate: string | null;
  goNumber: string | null;
  verificationStatus: "downloaded" | "public-reference";
  evidenceUrl: string;
}

interface ProbeResult {
  sourceId: string;
  encodedId: string;
  url: string;
  isPdf: boolean;
  classification: "pdf" | "empty-html" | "html" | "error";
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const reportArg = getArg("report");

  if (!reportArg) {
    throw new Error(
      "Usage: npm run promote:probe -- --report data/probes/.../report.json",
    );
  }

  const datasetPath = path.resolve("datasets/known-ids.json");
  const reportPath = path.resolve(reportArg);

  const dataset = JSON.parse(
    await readFile(datasetPath, "utf8"),
  ) as KnownId[];

  const report = JSON.parse(
    await readFile(reportPath, "utf8"),
  ) as ProbeResult[];

  const existing = new Set(dataset.map((record) => record.decodedId));

  // Build a conservative department-id -> label map only where existing
  // records agree on one label.
  const labelsByDepartmentId = new Map<number, Set<string>>();

  for (const record of dataset) {
    if (!record.department) continue;

    const { parts } = decodeShasanadeshId(record.encodedId);
    const labels =
      labelsByDepartmentId.get(parts.departmentId) ?? new Set<string>();

    labels.add(record.department);
    labelsByDepartmentId.set(parts.departmentId, labels);
  }

  let added = 0;

  for (const result of report) {
    if (!result.isPdf || result.classification !== "pdf") continue;
    if (existing.has(result.sourceId)) continue;

    const decoded = decodeShasanadeshId(result.encodedId);
    const labels = labelsByDepartmentId.get(decoded.parts.departmentId);
    const department =
      labels && labels.size === 1 ? [...labels][0] : null;

    dataset.push({
      encodedId: result.encodedId,
      decodedId: result.sourceId,
      department,
      goDate: null,
      goNumber: null,
      verificationStatus: "downloaded",
      evidenceUrl: result.url,
    });

    existing.add(result.sourceId);
    added++;
  }

  dataset.sort((a, b) => {
    const aa = decodeShasanadeshId(a.encodedId).parts;
    const bb = decodeShasanadeshId(b.encodedId).parts;

    return (
      aa.year - bb.year ||
      aa.departmentId - bb.departmentId ||
      aa.sectionId - bb.sectionId ||
      aa.sequence - bb.sequence
    );
  });

  await writeFile(
    datasetPath,
    JSON.stringify(dataset, null, 2) + "\n",
  );

  console.log(`Added ${added} new verified IDs.`);
  console.log(`Dataset now contains ${dataset.length} IDs.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
EOF

cat > src/ingest-known.ts <<'EOF'
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildShasanadeshPdfUrl,
  decodeShasanadeshId,
} from "./lib/shasanadesh-id.js";

const execFileAsync = promisify(execFile);

interface KnownId {
  encodedId: string;
  decodedId: string;
  department: string | null;
  goDate: string | null;
  goNumber: string | null;
  verificationStatus: "downloaded" | "public-reference";
  evidenceUrl: string;
}

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sourceDirName(sourceId: string): string {
  return sourceId.replaceAll("#", "-");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function extractPdfInfo(pdfPath: string): Promise<{
  available: boolean;
  pages: number | null;
  raw: string | null;
}> {
  try {
    const { stdout } = await execFileAsync("pdfinfo", [pdfPath], {
      maxBuffer: 5 * 1024 * 1024,
    });

    const match = stdout.match(/^Pages:\s+(\d+)/m);

    return {
      available: true,
      pages: match ? Number.parseInt(match[1], 10) : null,
      raw: stdout,
    };
  } catch {
    return {
      available: false,
      pages: null,
      raw: null,
    };
  }
}

async function extractText(
  pdfPath: string,
  textPath: string,
): Promise<{
  available: boolean;
  bytes: number;
  textSha256: string | null;
  normalizedTextSha256: string | null;
}> {
  try {
    await execFileAsync("pdftotext", [
      "-layout",
      "-enc",
      "UTF-8",
      pdfPath,
      textPath,
    ]);

    const text = await readFile(textPath, "utf8");
    const normalized = normalizeText(text);

    return {
      available: true,
      bytes: Buffer.byteLength(text),
      textSha256: text.length > 0 ? sha256(text) : null,
      normalizedTextSha256:
        normalized.length > 0 ? sha256(normalized) : null,
    };
  } catch {
    return {
      available: false,
      bytes: 0,
      textSha256: null,
      normalizedTextSha256: null,
    };
  }
}

async function ingestOne(
  record: KnownId,
  force: boolean,
): Promise<"downloaded" | "skipped" | "failed"> {
  const decoded = decodeShasanadeshId(record.encodedId);
  const sourceDir = path.resolve(
    "data/documents",
    sourceDirName(decoded.decodedId),
  );

  const pdfPath = path.join(sourceDir, "original.pdf");
  const textPath = path.join(sourceDir, "text.txt");
  const metadataPath = path.join(sourceDir, "metadata.json");

  await mkdir(sourceDir, { recursive: true });

  if (!force && (await exists(pdfPath)) && (await exists(metadataPath))) {
    console.log(`SKIP ${decoded.decodedId}`);
    return "skipped";
  }

  const sourceUrl = buildShasanadeshPdfUrl(decoded.base64);

  console.log(`\nINGEST ${decoded.decodedId}`);
  console.log(sourceUrl);

  try {
    const response = await fetch(sourceUrl, {
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
    const isPdf =
      response.ok &&
      buffer.subarray(0, 5).toString("ascii") === "%PDF-";

    if (!isPdf) {
      console.log(
        `FAILED ${decoded.decodedId}: HTTP ${response.status}, ${response.headers.get("content-type")}`,
      );
      return "failed";
    }

    await writeFile(pdfPath, buffer);

    const pdfInfo = await extractPdfInfo(pdfPath);
    const text = await extractText(pdfPath, textPath);

    const metadata = {
      provider: "shasanadesh-up",
      sourceId: decoded.decodedId,
      encodedId: decoded.base64,
      sourceUrl,
      department: record.department,
      goDate: record.goDate,
      goNumber: record.goNumber,
      verificationStatus: record.verificationStatus,
      evidenceUrl: record.evidenceUrl,

      idParts: decoded.parts,

      capture: {
        downloadedAt: new Date().toISOString(),
        status: response.status,
        contentType: response.headers.get("content-type"),
        bytes: buffer.length,
        rawSha256: sha256(buffer),
      },

      pdf: {
        pages: pdfInfo.pages,
        pdfInfoAvailable: pdfInfo.available,
      },

      text: {
        pdftotextAvailable: text.available,
        bytes: text.bytes,
        textSha256: text.textSha256,
        normalizedTextSha256: text.normalizedTextSha256,
        hasNativeText: text.bytes > 20,
      },
    };

    await writeFile(
      metadataPath,
      JSON.stringify(metadata, null, 2) + "\n",
    );

    console.log(
      `OK ${decoded.decodedId} | ${buffer.length} bytes | pages=${pdfInfo.pages ?? "?"} | text=${text.bytes} bytes`,
    );

    return "downloaded";
  } catch (error) {
    console.error(
      `FAILED ${decoded.decodedId}:`,
      error instanceof Error ? error.message : String(error),
    );

    return "failed";
  }
}

async function main() {
  const force = process.argv.includes("--force");
  const datasetPath = path.resolve("datasets/known-ids.json");

  const records = JSON.parse(
    await readFile(datasetPath, "utf8"),
  ) as KnownId[];

  console.log(`Known IDs: ${records.length}`);
  console.log(`Force:     ${force ? "yes" : "no"}`);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (let index = 0; index < records.length; index++) {
    const result = await ingestOne(records[index], force);

    if (result === "downloaded") downloaded++;
    if (result === "skipped") skipped++;
    if (result === "failed") failed++;

    if (index < records.length - 1 && result !== "skipped") {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  console.log("\n====================");
  console.log("Ingestion summary");
  console.log("====================");
  console.log(`Downloaded: ${downloaded}`);
  console.log(`Skipped:    ${skipped}`);
  console.log(`Failed:     ${failed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
EOF

npm pkg set scripts.promote:probe="tsx src/promote-probe-results.ts" >/dev/null
npm pkg set scripts.ingest:known="tsx src/ingest-known.ts" >/dev/null

echo
echo "Added:"
echo "  src/promote-probe-results.ts"
echo "  src/ingest-known.ts"
echo
echo "Run next:"
echo "  npx tsc --noEmit"
echo "  npm run promote:probe -- --report data/probes/163-1-2022-1-10/report.json"
echo "  npm run analyze:ids"
echo "  npm run ingest:known"
