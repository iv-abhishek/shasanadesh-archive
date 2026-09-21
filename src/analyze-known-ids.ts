/**
 * Shasanadesh Archive — documented pipeline file
 *
 * Pipeline stage: dataset analysis
 * Purpose: Summarize known ID patterns and validate the seed dataset.
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

import { readFile } from "node:fs/promises";
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

interface Group {
  departmentId: number;
  labels: Set<string>;
  years: Set<number>;
  sectionIds: Set<number>;
  sequences: number[];
  examples: string[];
}

const datasetPath = path.resolve("datasets/known-ids.json");

async function main() {
  const raw = await readFile(datasetPath, "utf8");
  const records = JSON.parse(raw) as KnownId[];

  const groups = new Map<number, Group>();
  const sourceIds = new Set<string>();
  let errors = 0;

  console.log(`Loaded ${records.length} known IDs.\n`);

  for (const record of records) {
    const decoded = decodeShasanadeshId(record.encodedId);

    if (decoded.decodedId !== record.decodedId) {
      console.error(
        `MISMATCH: ${record.encodedId}: dataset=${record.decodedId}, decoded=${decoded.decodedId}`,
      );
      errors++;
    }

    if (sourceIds.has(decoded.decodedId)) {
      console.error(`DUPLICATE SOURCE ID: ${decoded.decodedId}`);
      errors++;
    }

    sourceIds.add(decoded.decodedId);

    const { sequence, departmentId, sectionId, year } = decoded.parts;

    const group =
      groups.get(departmentId) ??
      {
        departmentId,
        labels: new Set<string>(),
        years: new Set<number>(),
        sectionIds: new Set<number>(),
        sequences: [],
        examples: [],
      };

    if (record.department) {
      group.labels.add(record.department);
    }

    group.years.add(year);
    group.sectionIds.add(sectionId);
    group.sequences.push(sequence);
    group.examples.push(decoded.decodedId);

    groups.set(departmentId, group);
  }

  console.log("Department ID summary");
  console.log("=====================");

  for (const group of [...groups.values()].sort(
    (a, b) => a.departmentId - b.departmentId,
  )) {
    const labels =
      group.labels.size > 0
        ? [...group.labels].sort().join(" | ")
        : "(unknown)";

    const years = [...group.years].sort((a, b) => a - b);
    const sections = [...group.sectionIds].sort((a, b) => a - b);
    const sequences = [...group.sequences].sort((a, b) => a - b);

    console.log(`\nDepartment ID: ${group.departmentId}`);
    console.log(`Label(s):      ${labels}`);
    console.log(`Records:       ${group.examples.length}`);
    console.log(`Years:         ${years.join(", ")}`);
    console.log(`Section IDs:   ${sections.join(", ")}`);
    console.log(
      `Sequence min/max: ${Math.min(...sequences)} / ${Math.max(...sequences)}`,
    );
    console.log(`Examples:      ${group.examples.slice(0, 6).join(", ")}`);
  }

  const downloaded = records.filter(
    (record) => record.verificationStatus === "downloaded",
  ).length;

  const referenced = records.length - downloaded;

  console.log("\n\nDataset validation");
  console.log("==================");
  console.log(`Total:              ${records.length}`);
  console.log(`Directly downloaded: ${downloaded}`);
  console.log(`Public references:   ${referenced}`);
  console.log(`Validation errors:   ${errors}`);

  if (errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
