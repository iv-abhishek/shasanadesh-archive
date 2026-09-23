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
        `${RAG_API_BASE_URL}/api/search`,
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

    const responseBody =
      await upstream.text();

    return new Response(
      responseBody,
      {
        status:
          upstream.status,
        headers: {
          "content-type":
            upstream.headers.get(
              "content-type",
            ) ??
            "application/json; charset=utf-8",
          "cache-control":
            "no-store",
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
