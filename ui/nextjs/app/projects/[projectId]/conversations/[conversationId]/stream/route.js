const controlApiUrl = (process.env.NODE_CONTROL_API_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { projectId, conversationId } = await params;
  const source = new URL(`${controlApiUrl}/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/stream`);
  const incoming = new URL(request.url);
  const after = incoming.searchParams.get("after");
  if (after) source.searchParams.set("after", after);
  const upstream = await fetch(source, {
    headers: { accept: "text/event-stream", ...(request.headers.get("last-event-id") ? { "last-event-id": request.headers.get("last-event-id") } : {}) },
    cache: "no-store",
    signal: request.signal
  });
  if (!upstream.body) return new Response("SSE upstream returned no body", { status: 502 });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-nodeforge-sse-route": "route-handler"
    }
  });
}
