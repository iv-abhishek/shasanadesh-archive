import assert from "node:assert/strict";
import {
  prepareEvidenceTextForGeneration,
  prepareNumericMetadataForGeneration,
  UNVERIFIED_NUMERIC,
} from "./generation-safety.js";

const risky =
  prepareEvidenceTextForGeneration(
    "Rules 1991 dated 15.08.2020 amount 50,000 and 20% level २.",
    "ocr_only_unverified",
  );

for (const token of [
  "1991",
  "15.08.2020",
  "50,000",
  "20",
  "२",
]) {
  assert.equal(
    risky.includes(token),
    false,
  );
}

assert.equal(
  risky.includes(UNVERIFIED_NUMERIC),
  true,
);

assert.equal(
  prepareEvidenceTextForGeneration(
    "Rules 1991.",
    "native_primary",
  ),
  "Rules 1991.",
);

assert.equal(
  prepareNumericMetadataForGeneration(
    "2023-09-15",
    "conflict",
  ),
  "unverified; check original source page",
);

console.log("generation-safety tests passed");
