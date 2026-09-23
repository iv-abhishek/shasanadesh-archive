import type {
  NextRequest,
} from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RAG_API_BASE_URL =
  process.env.RAG_API_BASE_URL ??
  "http://127.0.0.1:8787";

export async function POST(
  request: NextRequest,
): Promise<Response> {
  try {
    const body =
      await request.text();

    const upstream =
      await fetch(
        `${RAG_API_BASE_URL}/api/chat`,
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json",
          },
          body,
          cache: "no-store",
        },
      );

    if (!upstream.ok) {
      const errorBody =
        await upstream.text();

      return new Response(
        errorBody,
        {
          status:
            upstream.status,
          headers: {
            "content-type":
              upstream.headers.get(
                "content-type",
              ) ??
              "text/plain; charset=utf-8",
          },
        },
      );
    }

    if (!upstream.body) {
      return Response.json(
        {
          message:
            "RAG API returned no stream body.",
        },
        {
          status: 502,
        },
      );
    }

    return new Response(
      upstream.body,
      {
        status: 200,
        headers: {
          "content-type":
            upstream.headers.get(
              "content-type",
            ) ??
            "text/event-stream; charset=utf-8",
          "cache-control":
            "no-cache, no-transform",
          "x-accel-buffering":
            "no",
        },
      },
    );
  } catch (error) {
    return Response.json(
      {
        message:
          error instanceof Error
            ? error.message
            : String(error),
      },
      {
        status: 502,
      },
    );
  }
}
