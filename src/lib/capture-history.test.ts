import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preservePreviousCapture } from "./capture-history.js";

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "capture-history-"));

  assert.equal(await preservePreviousCapture(dir), null);

  await writeFile(path.join(dir, "original.pdf"), "%PDF-first");
  await writeFile(
    path.join(dir, "metadata.json"),
    JSON.stringify({ capture: { captureId: "cap-1", downloadedAt: "2026-01-01T00:00:00Z" } }),
  );

  const history = await preservePreviousCapture(dir);
  assert.equal(history?.length, 1);
  assert.equal(history?.[0].captureId, "cap-1");
  assert.equal(
    await readFile(path.join(dir, "captures/cap-1/original.pdf"), "utf8"),
    "%PDF-first",
  );

  // Second forced capture carries the earlier history forward.
  await writeFile(path.join(dir, "original.pdf"), "%PDF-second");
  await writeFile(
    path.join(dir, "metadata.json"),
    JSON.stringify({ capture: { captureId: "cap-2" }, previousCaptures: history }),
  );
  const next = await preservePreviousCapture(dir);
  assert.deepEqual(next?.map((item) => item.captureId), ["cap-1", "cap-2"]);

  // Unsafe capture IDs never become directory names.
  await writeFile(
    path.join(dir, "metadata.json"),
    JSON.stringify({ capture: { captureId: "../../evil" } }),
  );
  const safe = await preservePreviousCapture(dir);
  assert.match(safe!.at(-1)!.captureId, /^legacy-[0-9a-f]{16}$/);

  console.log("capture-history tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
