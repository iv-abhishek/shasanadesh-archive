import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const url =
  "https://shasanadesh.up.gov.in/GO/ViewGOPDF_list_user.aspx?id1=NSMxNjMjMiMyMDIx";

const outputDir = path.resolve("data/stability");

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function download() {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      Accept: "application/pdf,*/*",
    },
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function findDifferenceRanges(a: Buffer, b: Buffer) {
  const ranges: Array<{
    start: number;
    end: number;
  }> = [];

  const length = Math.min(a.length, b.length);

  let rangeStart: number | null = null;

  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) {
      if (rangeStart === null) {
        rangeStart = i;
      }
    } else if (rangeStart !== null) {
      ranges.push({
        start: rangeStart,
        end: i - 1,
      });

      rangeStart = null;
    }
  }

  if (rangeStart !== null) {
    ranges.push({
      start: rangeStart,
      end: length - 1,
    });
  }

  return ranges;
}

async function main() {
  await mkdir(outputDir, {
    recursive: true,
  });

  console.log("Downloading copy #1...");

  const first = await download();

  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log("Downloading copy #2...");

  const second = await download();

  const firstPath = path.join(outputDir, "copy-1.pdf");

  const secondPath = path.join(outputDir, "copy-2.pdf");

  await writeFile(firstPath, first);

  await writeFile(secondPath, second);

  console.log();
  console.log("Copy 1");
  console.log("Bytes:", first.length);
  console.log("SHA256:", sha256(first));

  console.log();

  console.log("Copy 2");
  console.log("Bytes:", second.length);
  console.log("SHA256:", sha256(second));

  console.log();

  console.log("Buffers identical:", first.equals(second));

  const ranges = findDifferenceRanges(first, second);

  const changedBytes = ranges.reduce(
    (total, range) => total + range.end - range.start + 1,
    0,
  );

  console.log("Changed bytes:", changedBytes);

  console.log("Difference ranges:");

  for (const range of ranges) {
    console.log(`${range.start}-${range.end}`);
  }

  console.log();
  console.log(`Saved: ${firstPath}`);

  console.log(`Saved: ${secondPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
