import type {
  NextRequest,
} from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RAG_API_BASE_URL =
  process.env.RAG_API_BASE_URL ??
  "http://127.0.0.1:8787";

async function proxy(
  request: NextRequest,
  context: {
    params:
      Promise<{
        path: string[];
      }>;
  },
): Promise<Response> {
  const {
    path,
  } =
    await context.params;

  const upstreamUrl =
    new URL(
      `/api/session/${path
        .map(
          encodeURIComponent,
        )
        .join("/")}`,
      RAG_API_BASE_URL,
    );

  const headers =
    new Headers();

  const contentType =
    request.headers.get(
      "content-type",
    );

  if (contentType) {
    headers.set(
      "content-type",
      contentType,
    );
  }

  const cookie =
    request.headers.get(
      "cookie",
    );

  if (cookie) {
    headers.set(
      "cookie",
      cookie,
    );
  }

  const method =
    request.method;

  const body =
    method === "GET" ||
    method === "HEAD"
      ? undefined
      : await request.text();

  try {
    const upstream =
      await fetch(
        upstreamUrl,
        {
          method,
          headers,
          body,
          cache:
            "no-store",
        },
      );

    const responseHeaders =
      new Headers();

    responseHeaders.set(
      "content-type",
      upstream.headers.get(
        "content-type",
      ) ??
      "application/json; charset=utf-8",
    );

    responseHeaders.set(
      "cache-control",
      "no-store",
    );

    const setCookie =
      upstream.headers.get(
        "set-cookie",
      );

    if (setCookie) {
      responseHeaders.set(
        "set-cookie",
        setCookie,
      );
    }

    return new Response(
      upstream.body,
      {
        status:
          upstream.status,
        headers:
          responseHeaders,
      },
    );
  } catch (error) {
    return Response.json(
      {
        error:
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

export {
  proxy as GET,
  proxy as POST,
};
