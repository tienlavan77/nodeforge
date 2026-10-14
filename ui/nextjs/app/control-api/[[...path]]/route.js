// Handles same-origin API traffic gracefully while the backend restarts, including live event streams.
import { proxyControlApi } from "../../../lib/control-api-proxy.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Forwards approved UI API routes without automatically replaying backend mutations.
async function handle(request, { params }) {
  const { path = [] } = await params;
  return proxyControlApi(request, path);
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };
