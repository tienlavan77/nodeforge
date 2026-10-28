// Verifies UI requests and live streams recover across API restarts without replaying mutations.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { proxyControlApi } from "../lib/control-api-proxy.js";
import { GET, POST, runtime, dynamic } from "../app/control-api/[[...path]]/route.js";
import nextConfig from "../next.config.js";

// Runs isolated backend fixtures and captures controlled diagnostics instead of real restart noise.
async function fixture(context, handler) {
  const diagnostics = [];
  context.mock.method(console, "warn", (message) => diagnostics.push(message));
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { server, port, origin: `http://127.0.0.1:${port}`, diagnostics };
}

// Builds browser-like same-origin requests while retaining method, body and cancellation signals.
function browserRequest(path = "/forge/v1/health", options = {}) {
  return new Request(`http://ui.test${path}`, options);
}

test("all API rewrites use the controlled route rather than Next's throwing external proxy", async () => {
  const routes = (await nextConfig.rewrites()).afterFiles;
  assert.equal(routes.length, 6);
  assert.ok(routes.every((route) => route.destination.startsWith("/control-api/")));
  assert.equal(routes.find((route) => route.source === "/api/:path*").destination, "/control-api/:path*");
  assert.equal(GET, POST);
  assert.equal(runtime, "nodejs");
  assert.equal(dynamic, "force-dynamic");
});

test("API downtime returns structured 503 and the next request succeeds after restart", async (context) => {
  const { server, port, origin, diagnostics } = await fixture(context, (request, response) => response.end('{"status":"ok"}'));
  await new Promise((resolve) => server.close(resolve));
  const failed = await proxyControlApi(browserRequest(undefined, { headers: { "x-request-id": "RESTART-1" } }), ["forge", "v1", "health"], { origin });
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("retry-after"), "1");
  const error = (await failed.json()).error;
  assert.equal(error.code, "CONTROL_API_UNAVAILABLE");
  assert.equal(error.requestId, "RESTART-1");
  assert.equal(error.retryable, true);
  assert.deepEqual(diagnostics, ["Control API request failed: GET /forge/v1/health; code=ECONNREFUSED; reused_socket=false - WAIT"]);
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const recovered = await proxyControlApi(browserRequest(), ["forge", "v1", "health"], { origin });
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { status: "ok" });
});

test("route handler forwards the configured backend origin and awaited path parameters", async (context) => {
  const { origin } = await fixture(context, (request, response) => {
    assert.equal(request.url, "/forge/v1/health?probe=restart");
    response.end("ready");
  });
  const previous = process.env.NODE_CONTROL_API_URL;
  context.after(() => { if (previous === undefined) delete process.env.NODE_CONTROL_API_URL; else process.env.NODE_CONTROL_API_URL = previous; });
  process.env.NODE_CONTROL_API_URL = origin;
  const response = await GET(browserRequest("/control-api/forge/v1/health?probe=restart"), { params: Promise.resolve({ path: ["forge", "v1", "health"] }) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ready");
});

test("POST body, query, auth and backend errors are forwarded exactly once", { timeout: 5000 }, async (context) => {
  let calls = 0;
  const { origin } = await fixture(context, async (request, response) => {
    calls += 1;
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/forge/v1/tickets/fixture:run?project_id=PROJECT-A");
    assert.equal(request.headers.authorization, "Bearer fixture");
    assert.equal(body, '{"fresh":false}');
    response.writeHead(409, { "content-type": "application/json", "x-request-id": "REQ-UPSTREAM" });
    response.end('{"error":{"code":"TICKET_APPROVAL_REQUIRED"}}');
  });
  const request = browserRequest("/forge/v1/tickets/fixture:run?project_id=PROJECT-A", { method: "POST", body: '{"fresh":false}', headers: { authorization: "Bearer fixture", "content-type": "application/json" } });
  const result = await proxyControlApi(request, ["forge", "v1", "tickets", "fixture:run"], { origin });
  assert.equal(result.status, 409);
  assert.equal(result.headers.get("x-request-id"), "REQ-UPSTREAM");
  assert.equal((await result.json()).error.code, "TICKET_APPROVAL_REQUIRED");
  assert.equal(calls, 1);
});

test("an interrupted mutation returns 503 without being automatically replayed", async (context) => {
  let calls = 0;
  const { origin } = await fixture(context, (request) => { calls += 1; request.socket.destroy(); });
  const response = await proxyControlApi(browserRequest("/forge/v1/tickets/fixture:run", { method: "POST", body: "{}" }), ["forge", "v1", "tickets", "fixture:run"], { origin });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.retryable, false);
  assert.equal(calls, 1);
});

test("SSE sends events immediately, ends cleanly on restart and reconnects", async (context) => {
  let upstream;
  const { origin, diagnostics } = await fixture(context, (request, response) => {
    upstream = response;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(`id: 7\ndata: ${request.headers["last-event-id"] ?? "first"}\n\n`);
  });
  const response = await proxyControlApi(browserRequest(), ["forge", "v1", "projects", "fixture", "stream"], { origin });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /data: first/);
  upstream.destroy();
  assert.equal((await reader.read()).done, true);
  assert.ok(diagnostics.some((message) => message.includes("stream disconnected")));
  const reopened = await proxyControlApi(browserRequest(undefined, { headers: { "last-event-id": "7" } }), ["forge", "v1", "projects", "fixture", "stream"], { origin });
  const recoveredReader = reopened.body.getReader();
  assert.match(new TextDecoder().decode((await recoveredReader.read()).value), /data: 7/);
  await recoveredReader.cancel();
});

test("proxy retains idle timeout protection with a structured 504", async (context) => {
  const { origin } = await fixture(context, () => {});
  const response = await proxyControlApi(browserRequest(), ["forge", "v1", "health"], { origin, timeoutMs: 30 });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "CONTROL_API_TIMEOUT");
});

test("active SSE heartbeats reset the idle timeout instead of imposing a total duration limit", async (context) => {
  const { origin } = await fixture(context, (request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": connected\n\n");
    let heartbeats = 0;
    const timer = setInterval(() => {
      response.write(": heartbeat\n\n");
      heartbeats += 1;
      if (heartbeats === 5) { clearInterval(timer); response.end(); }
    }, 20);
    response.once("close", () => clearInterval(timer));
  });
  const response = await proxyControlApi(browserRequest(), ["forge", "v1", "stream"], { origin, timeoutMs: 70 });
  assert.equal((await response.text()).match(/heartbeat/g).length, 5);
});

test("client cancellation settles before headers and never retries the request", async (context) => {
  const { origin } = await fixture(context, () => {});
  const controller = new AbortController();
  controller.abort();
  const result = await proxyControlApi(browserRequest(undefined, { signal: controller.signal }), ["forge", "v1", "health"], { origin });
  assert.equal(result.status, 499);
});

test("HEAD and empty responses preserve status without constructing an invalid body", async (context) => {
  const { origin } = await fixture(context, (request, response) => { response.writeHead(204); response.end(); });
  const result = await proxyControlApi(browserRequest(undefined, { method: "HEAD" }), ["forge", "v1", "health"], { origin });
  assert.equal(result.status, 204);
  assert.equal(result.body, null);
});

// Warm the production proxy's keep-alive pool before simulating a reset on that socket.
async function warmConnection(origin) {
  const response = await proxyControlApi(browserRequest(undefined, { headers: { "x-probe": "warm" } }), ["forge", "v1", "health"], { origin });
  await response.text();
  await new Promise((resolve) => setImmediate(resolve));
}

for (const method of ["GET", "HEAD", "OPTIONS"]) {
  test(`${method} recovers a reset reused socket while the same API stays running`, async (context) => {
    const sockets = new WeakSet();
    let calls = 0;
    const { origin, server, diagnostics } = await fixture(context, (request, response) => {
      if (request.headers["x-probe"] === "warm") { sockets.add(request.socket); response.end("warm"); return; }
      calls++;
      if (sockets.has(request.socket)) { request.socket.destroy(); return; }
      response.end("ready");
    });
    await warmConnection(origin);
    const result = await proxyControlApi(browserRequest(undefined, { method }), ["forge", "v1", "health"], { origin });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), method === "HEAD" ? "" : "ready");
    assert.equal(calls, 2);
    assert.equal(server.listening, true);
    assert.deepEqual(diagnostics, []);
  });
}

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`${method} on a reset reused socket is never replayed`, async (context) => {
    const sockets = new WeakSet();
    let calls = 0;
    const { origin, diagnostics } = await fixture(context, (request, response) => {
      if (request.headers["x-probe"] === "warm") { sockets.add(request.socket); response.end("warm"); return; }
      assert.equal(sockets.has(request.socket), true);
      calls++;
      request.socket.destroy();
    });
    await warmConnection(origin);
    const result = await proxyControlApi(browserRequest(undefined, { method, body: "{}" }), ["forge", "v1", "health"], { origin });
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error.retryable, false);
    assert.equal(calls, 1);
    assert.match(diagnostics[0], new RegExp(`${method} /forge/v1/health; code=ECONNRESET; reused_socket=true`));
  });
}

test("a reset on a fresh socket is reported without another automatic retry", async (context) => {
  let calls = 0;
  const { origin, diagnostics } = await fixture(context, (request) => { calls++; request.socket.destroy(); });
  const result = await proxyControlApi(browserRequest("/forge/v1/health?token=private"), ["forge", "v1", "health"], { origin });
  assert.equal(result.status, 503);
  assert.equal(calls, 1);
  assert.match(diagnostics[0], /GET \/forge\/v1\/health; code=ECONNRESET; reused_socket=false/);
  assert.doesNotMatch(diagnostics[0], /private|token=|\[UI\]/);
});

test("a read retries at most once if the fresh connection also resets", async (context) => {
  let calls = 0;
  const { origin } = await fixture(context, (request, response) => {
    if (request.headers["x-probe"] === "warm") { response.end("warm"); return; }
    calls++;
    request.socket.destroy();
  });
  await warmConnection(origin);
  const result = await proxyControlApi(browserRequest(), ["forge", "v1", "health"], { origin });
  assert.equal(result.status, 503);
  assert.equal(calls, 2);
});
