// Keeps UI API requests and live streams recoverable while the Node service restarts.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

// Removes connection-specific headers before forwarding browser requests or backend responses.
function forwardedHeaders(input) {
  const headers = input instanceof Headers ? new Headers(input) : new Headers();
  if (!(input instanceof Headers)) {
    for (const [name, value] of Object.entries(input)) {
      if (value !== undefined) for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
    }
  }
  const connectionHeaders = (headers.get("connection") ?? "").split(",");
  for (const name of [...HOP_HEADERS, ...connectionHeaders]) if (name.trim()) headers.delete(name.trim());
  return headers;
}

// Returns actionable downtime errors without retrying commands that may already have executed.
function unavailableResponse(error, requestId, method) {
  if (error.code === "ABORT_ERR") return new Response(null, { status: 499 });
  const timeout = error.code === "ETIMEDOUT";
  console.warn(`[UI] Control API ${timeout ? "timeout" : "unavailable"}: ${error.code ?? error.name ?? "UNKNOWN"}`);
  return Response.json({ error: {
    code: timeout ? "CONTROL_API_TIMEOUT" : "CONTROL_API_UNAVAILABLE",
    message: timeout ? "Node did not respond before the proxy deadline." : "Node is temporarily unavailable or restarting. Please reconnect when the service is ready.",
    retryable: ["GET", "HEAD", "OPTIONS"].includes(method), scope: "global", requestId
  } }, { status: timeout ? 504 : 503, headers: { "cache-control": "no-store", "retry-after": "1", ...(requestId ? { "x-request-id": requestId } : {}) } });
}

// Streams each API request exactly once and turns restart disconnects into controlled UI recovery.
export async function proxyControlApi(request, path, { origin = process.env.NODE_CONTROL_API_URL ?? "http://127.0.0.1:3100", timeoutMs = Number(process.env.NODE_CONTROL_API_PROXY_TIMEOUT_MS ?? Number(process.env.NODE_SDK_AGENT_TIMEOUT_MS ?? 3600000) + 60000) } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("NODE_CONTROL_API_PROXY_TIMEOUT_MS must be a positive integer in milliseconds.");
  const target = new URL(`${origin.replace(/\/$/, "")}/${path.map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":")).join("/")}`);
  target.search = new URL(request.url).search;
  const headers = forwardedHeaders(request.headers);
  headers.delete("host");
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let upload;
    let upstream;
    // Releases client cancellation listeners once a response or disconnected stream is finished.
    const cleanup = () => request.signal.removeEventListener("abort", abort);
    // Cancels upstream work when the browser disconnects instead of leaving orphan proxy sockets.
    const abort = () => { outgoing.destroy(Object.assign(new Error("Browser disconnected."), { code: "ABORT_ERR" })); upstream?.destroy(); upload?.destroy(); };
    const outgoing = send(target, { method: request.method, headers: Object.fromEntries(headers) }, (response) => {
      upstream = response;
      const responseHeaders = forwardedHeaders(response.headers);
      if ([204, 205, 304].includes(response.statusCode) || request.method === "HEAD") {
        response.resume();
        response.once("end", cleanup);
        resolve(new Response(null, { status: response.statusCode, headers: responseHeaders }));
        return;
      }
      const reader = Readable.toWeb(response).getReader();
      const body = new ReadableStream({
        // Streams live events immediately and closes cleanly when an API restart interrupts the connection.
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { cleanup(); controller.close(); }
            else controller.enqueue(chunk.value);
          } catch (error) {
            cleanup();
            if (!request.signal.aborted) console.warn(`[UI] Control API stream disconnected: ${error.code ?? error.name}`);
            controller.close();
          }
        },
        // Stops the backend stream as soon as the browser no longer consumes it.
        cancel() { cleanup(); abort(); return reader.cancel(); }
      });
      resolve(new Response(body, { status: response.statusCode, headers: responseHeaders }));
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(Object.assign(new Error("Control API proxy timed out."), { code: "ETIMEDOUT" })));
    outgoing.once("error", (error) => { cleanup(); upload?.destroy(); resolve(unavailableResponse(error, request.headers.get("x-request-id"), request.method)); });
    outgoing.once("close", () => { if (!upstream) cleanup(); });
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    else if (request.body) {
      upload = Readable.fromWeb(request.body);
      upload.once("error", (error) => outgoing.destroy(error));
      upload.pipe(outgoing);
    } else outgoing.end();
  });
}
