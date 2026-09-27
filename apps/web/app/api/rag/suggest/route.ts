import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RAG_API_BASE_URL = process.env.RAG_API_BASE_URL ?? "http://127.0.0.1:8787";

// Follow-up questions under an answer (ADR-065). Failures return an empty list:
// suggestions are a convenience and must never show an error.
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const upstream = await fetch(`${RAG_API_BASE_URL}/api/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await request.text(),
      cache: "no-store",
      signal: request.signal,
    });
    if (!upstream.ok) return Response.json({ suggestions: [] });
    return Response.json(await upstream.json());
  } catch {
    return Response.json({ suggestions: [] });
  }
}
