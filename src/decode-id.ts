import { Buffer } from "node:buffer";
const ids = [
  "NSMxNjMjMiMyMDIx",
  "MTQjMzQjNiMyMDI1",
  "MjIjNTAwMDIjMTAjMjAyNA%3D%3D",
];

function decodeId(encodedId: string) {
  const urlDecoded = decodeURIComponent(encodedId);

  const decoded = Buffer.from(urlDecoded, "base64").toString("utf8");

  return {
    encodedId,
    base64: urlDecoded,
    decoded,
    parts: decoded.split("#"),
  };
}

for (const id of ids) {
  const result = decodeId(id);

  console.log("\n-------------------------");
  console.log("Encoded :", result.encodedId);
  console.log("Decoded :", result.decoded);
  console.log("Parts   :", result.parts);

  console.log({
    part1: result.parts[0],
    part2: result.parts[1],
    part3: result.parts[2],
    part4: result.parts[3],
  });
}
