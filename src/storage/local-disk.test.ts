import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { diskSpaceProblem, minFreeBytes, projectBytes, sameAsB2 } from "./local-disk.js";
import type { B2CaptureStorage } from "./b2.js";

async function main(): Promise<void> {
  // Floor: default 40 GB, configurable, 0 disables.
  assert.equal(minFreeBytes({}), 40e9);
  assert.equal(minFreeBytes({ MIN_FREE_DISK_GB: "100" }), 100e9);
  assert.equal(minFreeBytes({ MIN_FREE_DISK_GB: "0" }), 0);
  assert.equal(minFreeBytes({ MIN_FREE_DISK_GB: "lots" }), 40e9);
  assert.equal(await diskSpaceProblem(".", { MIN_FREE_DISK_GB: "0" }), null);
  assert.match((await diskSpaceProblem(".", { MIN_FREE_DISK_GB: "1000000" })) ?? "", /^Stopping: only .* free/);

  // Eviction needs a B2 copy with the same SHA-256, in the configured bucket.
  const bytes = Buffer.from("%PDF-1.7 test");
  const storage = {
    provider: "backblaze-b2-native", bucket: "shasanadesh", collection: "shasanadesh",
    raw: { key: "k", fileId: "f", bytes: bytes.length, sha1: "", sha256: createHash("sha256").update(bytes).digest("hex"), uploadedAt: "" },
    metadata: { key: "m", fileId: "g", bytes: 1, sha1: "", sha256: "", uploadedAt: "" },
  } as B2CaptureStorage;
  assert.equal(sameAsB2(storage, bytes, "shasanadesh"), true);
  assert.equal(sameAsB2(storage, Buffer.from("changed"), "shasanadesh"), false);
  assert.equal(sameAsB2(storage, bytes, "another-bucket"), false);
  assert.equal(sameAsB2({ ...storage, raw: { ...storage.raw, fileId: "" } }, bytes, "shasanadesh"), false);
  assert.equal(sameAsB2(undefined, bytes, "shasanadesh"), false);

  // Projection: per-tier size × tier share × total.
  assert.equal(projectBytes({ A: 1000, C: 10 }, { A: 0.1, C: 0.9 }, 100), 1000 * 10 + 10 * 90);

  console.log("local-disk tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
