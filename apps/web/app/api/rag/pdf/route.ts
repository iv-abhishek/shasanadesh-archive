import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_HOST = "shasanadesh.up.gov.in";
const ALLOWED_PATH = "/GO/ViewGOPDF_list_user.aspx";

function validateSourceUrl(raw: string): URL {
  const parsed = new URL(raw);

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== ALLOWED_HOST ||
    parsed.pathname !== ALLOWED_PATH
  ) {
    throw new Error("Unsupported PDF source URL.");
  }

  if (!parsed.searchParams.has("id1")) {
    throw new Error("PDF source URL is missing id1.");
  }

  parsed.hash = "";
  return parsed;
}

export async function GET(request: NextRequest): Promise<Response> {
  const raw = request.nextUrl.searchParams.get("url");

  if (!raw) {
    return Response.json(
      { message: "Missing url parameter." },
      { status: 400 },
    );
  }

  let sourceUrl: URL;

  try {
    sourceUrl = validateSourceUrl(raw);
  } catch (error) {
    return Response.json(
      {
        message:
          error instanceof Error ? error.message : String(error),
      },
      { status: 400 },
    );
  }

  try {
    const headers = new Headers();
    const range = request.headers.get("range");

    if (range) {
      headers.set("range", range);
    }

    const upstream = await fetch(sourceUrl, {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "follow",
    });

    if (!upstream.ok) {
      return Response.json(
        { message: `Source PDF returned ${upstream.status}.` },
        { status: 502 },
      );
    }

    const responseHeaders = new Headers();

    responseHeaders.set(
      "content-type",
      upstream.headers.get("content-type") ?? "application/pdf",
    );
    responseHeaders.set("cache-control", "private, max-age=300");
    responseHeaders.set("content-disposition", "inline");

    for (const name of [
      "accept-ranges",
      "content-range",
      "content-length",
      "etag",
      "last-modified",
    ]) {
      const value = upstream.headers.get(name);
      if (value) {
        responseHeaders.set(name, value);
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return Response.json(
      {
        message:
          error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
