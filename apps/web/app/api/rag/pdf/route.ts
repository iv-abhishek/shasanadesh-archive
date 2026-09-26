import type { NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serves archived original PDFs for the in-app source viewer.
//
// Source IDs come from every registered provider:
//   - Shasanadesh: four numeric fields joined by "#" (stored as a-b-c-d)
//   - other adapters (e.g. doe-gfr-<hash>): lowercase letters, digits, hyphens
// Both patterns exclude path separators and "..", so the resolved path always
// stays inside data/documents.
const SHASANADESH_ID_RE = /^\d+#\d+#\d+#\d+$/;
const ADAPTER_ID_RE = /^[a-z0-9][a-z0-9-]{0,100}$/;

const SHASANADESH_HOST = "shasanadesh.up.gov.in";
const SHASANADESH_PATH = "/GO/ViewGOPDF_list_user.aspx";

function validateSourceId(value: string): string {
  if (!SHASANADESH_ID_RE.test(value) && !ADAPTER_ID_RE.test(value)) {
    throw new Error("Unsupported source ID.");
  }

  return value;
}

// Legacy links passed the official Shasanadesh URL instead of a source ID.
function sourceIdFromShasanadeshUrl(raw: string): string {
  const parsed = new URL(raw);

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== SHASANADESH_HOST ||
    parsed.pathname !== SHASANADESH_PATH
  ) {
    throw new Error("Unsupported PDF source URL. Pass sourceId instead.");
  }

  const encodedId = parsed.searchParams.get("id1");

  if (!encodedId) {
    throw new Error("PDF source URL is missing id1.");
  }

  return validateSourceId(Buffer.from(encodedId, "base64").toString("utf8"));
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

  return sourceIdFromShasanadeshUrl(rawUrl);
}

function archivePdfPath(sourceId: string): string {
  const directoryName = sourceId.replaceAll("#", "-");

  // The dev server may run from apps/web or from the repository root.
  const candidates = [
    path.resolve(process.cwd(), "data/documents", directoryName, "original.pdf"),
    path.resolve(process.cwd(), "../../data/documents", directoryName, "original.pdf"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export async function GET(request: NextRequest): Promise<Response> {
  let sourceId: string;

  try {
    sourceId = getSourceId(request);
  } catch (error) {
    return Response.json(
      { message: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }

  try {
    const pdf = await readFile(archivePdfPath(sourceId));

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
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 404 },
    );
  }
}
