import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same-origin proxy for the read-only archive browse API (browse, facets).
const RAG_API_BASE_URL = process.env.RAG_API_BASE_URL ?? "http://127.0.0.1:8787";
const ACTIONS = new Set(["browse", "facets"]);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await context.params;
  if (!ACTIONS.has(action)) {
    return Response.json({ error: "Unknown documents action." }, { status: 404 });
  }

  try {
    const upstream = await fetch(`${RAG_API_BASE_URL}/api/documents/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await request.text(),
      cache: "no-store",
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    return Response.json(
      {
        error: "The archive API is not reachable. Start the stack with npm run dev:all.",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
