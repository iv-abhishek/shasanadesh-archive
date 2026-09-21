import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const documents = [
  {
    name: "personnel-2021",
    url: "https://shasanadesh.up.gov.in/GO/ViewGOPDF_list_user.aspx?id1=NSMxNjMjMiMyMDIx",
  },
  {
    name: "pwd-2025",
    url: "https://shasanadesh.up.gov.in/GO/ViewGOPDF_list_user.aspx?id1=MTQjMzQjNiMyMDI1",
  },
  {
    name: "secondary-education-2024",
    url: "https://shasanadesh.up.gov.in/GO/ViewGOPDF_list_user.aspx?id1=MjIjNTAwMDIjMTAjMjAyNA%3D%3D",
  },
];

const outputDir = path.resolve("data/pdfs");

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isPdf(buffer: Buffer) {
  return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

async function downloadDocument(name: string, url: string) {
  console.log("\n--------------------------------");
  console.log(`Downloading: ${name}`);
  console.log(url);

  const started = Date.now();

  try {
    const response = await fetch(url, {
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

    const pdf = isPdf(buffer);
    const hash = sha256(buffer);

    console.log("Status:", response.status);
    console.log("Content-Type:", response.headers.get("content-type"));
    console.log("Final URL:", response.url);
    console.log("Size:", `${buffer.length} bytes`);
    console.log("PDF:", pdf ? "YES" : "NO");
    console.log("SHA256:", hash);
    console.log("Time:", `${Date.now() - started}ms`);

    if (response.ok && pdf) {
      const filename = path.join(outputDir, `${hash}.pdf`);

      await writeFile(filename, buffer);

      console.log("SAVED:", filename);
    } else {
      const filename = path.join(outputDir, `${name}.response.html`);

      await writeFile(filename, buffer);

      console.log("NOT PDF");
      console.log("Response saved:", filename);
    }
  } catch (error) {
    console.error("ERROR:", error);
  }
}

async function main() {
  await mkdir(outputDir, {
    recursive: true,
  });

  for (const document of documents) {
    await downloadDocument(document.name, document.url);

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
