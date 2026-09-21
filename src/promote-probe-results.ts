/**
 * Shasanadesh Archive — documented pipeline file
 *
 * Pipeline stage: dataset maintenance
 * Purpose: Promote verified diagnostic results into the known-ID dataset.
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
