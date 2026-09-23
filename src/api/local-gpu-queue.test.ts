import assert from "node:assert/strict";
import {
  getLocalGpuQueueStatus,
  runLocalGpuExclusive,
} from "./local-gpu-queue.js";

async function main(): Promise<void> {
  let active = 0;
  let maxActive = 0;

  async function job(
    label: string,
    delayMs: number,
  ): Promise<string> {
    return runLocalGpuExclusive(
      label,
      async () => {
        active += 1;
        maxActive =
          Math.max(maxActive, active);

        await new Promise<void>(
          (resolve) =>
            setTimeout(resolve, delayMs),
        );

        active -= 1;
        return label;
      },
    );
  }

  const result =
    await Promise.all([
      job("one", 20),
      job("two", 10),
      job("three", 5),
    ]);

  assert.deepEqual(
    result,
    ["one", "two", "three"],
  );

  assert.equal(maxActive, 1);

  const status =
    getLocalGpuQueueStatus();

  assert.equal(status.active, 0);
  assert.equal(status.waiting, 0);
  assert.equal(status.completed >= 3, true);

  console.log("local-gpu-queue tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
