import type { NextRequest } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_HOST = "shasanadesh.up.gov.in";
const ALLOWED_PATH = "/GO/ViewGOPDF_list_user.aspx";
const SOURCE_ID_RE = /^\d+#\d+#\d+#\d+$/;

function validateSourceId(value: string): string {
  if (!SOURCE_ID_RE.test(value)) {
    throw new Error("Unsupported source ID.");
  }

  return value;
}

function sourceIdFromUrl(raw: string): string {
  const parsed = new URL(raw);

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== ALLOWED_HOST ||
    parsed.pathname !== ALLOWED_PATH
  ) {
    throw new Error("Unsupported PDF source URL.");
  }

  const encodedId = parsed.searchParams.get("id1");

  if (!encodedId) {
    throw new Error("PDF source URL is missing id1.");
  }

  const decoded = Buffer.from(encodedId, "base64").toString("utf8");

  return validateSourceId(decoded);
}

function getSourceId(request: NextRequest): string {
  const explicit = request.nextUrl.searchParams.get("sourceId");

  if (explicit) {
    return validateSourceId(explicit);
  }

  const rawUrl = request.nextUrl.searchParams.get("url");

  if (!rawUrl) {
    throw new Error("Missing sourceId or url parameter.");
  }

  return sourceIdFromUrl(rawUrl);
}

function archivePdfPath(sourceId: string): string {
  const directoryName = sourceId.replaceAll("#", "-");

  const candidates = [
    path.resolve(
      process.cwd(),
      "data/documents",
      directoryName,
      "original.pdf",
    ),
    path.resolve(
      process.cwd(),
      "../../data/documents",
      directoryName,
      "original.pdf",
    ),
  ];

  return candidates.find((candidate) => {
    try {
      require("node:fs").accessSync(candidate);
      return true;
    } catch {
      return false;
    }
  }) ?? candidates[0];
}

export async function GET(request: NextRequest): Promise<Response> {
  let sourceId: string;

  try {
    sourceId = getSourceId(request);
  } catch (error) {
    return Response.json(
      {
        message:
          error instanceof Error
            ? error.message
            : String(error),
      },
      { status: 400 },
    );
  }

  try {
    const pdfPath = archivePdfPath(sourceId);
    const pdf = await readFile(pdfPath);

    if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("Archived file is not a PDF.");
    }

    return new Response(pdf, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(pdf.length),
        "content-disposition": "inline",
        "cache-control": "private, max-age=300",
      },
    });
  } catch (error) {
    return Response.json(
      {
        message: "Archived PDF is unavailable.",
        sourceId,
        detail:
          error instanceof Error
            ? error.message
            : String(error),
      },
      { status: 404 },
    );
  }
}
