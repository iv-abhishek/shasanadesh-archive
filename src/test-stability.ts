import { createHash } from "node:crypto";

const url =
  "https://shasanadesh.up.gov.in/GO/ViewGOPDF_list_user.aspx?id1=NSMxNjMjMiMyMDIx";

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function download() {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      Accept: "application/pdf,*/*",
    },
  });

  const buffer = Buffer.from(await response.arrayBuffer());

  return buffer;
}

async function main() {
  console.log("Downloading copy #1...");

  const first = await download();

  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log("Downloading copy #2...");

  const second = await download();

  console.log();
  console.log("Copy 1:");
  console.log("Bytes:", first.length);
  console.log("SHA256:", sha256(first));

  console.log();

  console.log("Copy 2:");
  console.log("Bytes:", second.length);
  console.log("SHA256:", sha256(second));

  console.log();

  console.log("Buffers identical:", first.equals(second));

  if (!first.equals(second)) {
    let changedBytes = 0;
    let firstDifference = -1;

    const length = Math.min(first.length, second.length);

    for (let i = 0; i < length; i++) {
      if (first[i] !== second[i]) {
        changedBytes++;

        if (firstDifference === -1) {
          firstDifference = i;
        }
      }
    }

    console.log("Changed byte positions:", changedBytes);

    console.log("First difference:", firstDifference);
  }
}

main().catch(console.error);
