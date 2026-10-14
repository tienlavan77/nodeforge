// Reproduces the real Next proxy timeout while an upstream planning request continues, then verifies the configured deadline fixes it.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { parse } from "node:url";
import { Readable } from "node:stream";
import nextConfig from "../next.config.js";
import { proxyControlApi } from "../lib/control-api-proxy.js";

const require = createRequire(import.meta.url);
const { proxyRequest } = require("../node_modules/next/dist/server/lib/router-utils/proxy-request.js");

// Starts isolated HTTP fixtures and closes every socket after proxy verification.
async function listen(context, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("real Next proxy: default returns Internal Server Error while configured proxy receives a 31-second planning result", { timeout: 45000 }, async (context) => {
  const diagnostics = []; let requests = 0; let completed = 0;
  context.mock.method(console, "error", (...args) => diagnostics.push(args));
  const upstream = await listen(context, (request, response) => {
    requests += 1;
    const timer = setTimeout(() => {
      completed += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "completed", request_was_running: true }));
    }, 31000);
    context.after(() => clearTimeout(timer));
  });
  // Executes the installed Next proxy, not a mock of its timeout implementation.
  const handler = (timeout) => async (request, response) => {
    try { await proxyRequest(request, response, parse(`${upstream}${request.url}`, true), undefined, undefined, timeout); }
    catch (error) { diagnostics.push(error); if (!response.writableEnded && !response.destroyed) { response.statusCode = 500; response.end("Internal Server Error"); } }
  };
  const original = await listen(context, handler(undefined));
  // Exercises the restart-safe route proxy with the existing long-request deadline.
  const fixed = await listen(context, async (request, response) => {
    const incoming = new Request(`http://ui.test${request.url}`, { method: request.method, headers: request.headers });
    const result = await proxyControlApi(incoming, request.url.split("/").filter(Boolean), { origin: upstream, timeoutMs: nextConfig.experimental.proxyTimeout });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    Readable.fromWeb(result.body).pipe(response);
  });
  const [before, after] = await Promise.all([
    fetch(`${original}/forge/v1/conversations/fixture/messages`, { method: "POST" }).then(async (response) => ({ status: response.status, body: await response.text() })),
    fetch(`${fixed}/forge/v1/conversations/fixture/messages`, { method: "POST" }).then(async (response) => ({ status: response.status, body: await response.json() }))
  ]);
  assert.equal(before.status, 500); assert.equal(before.body, "Internal Server Error");
  assert.equal(after.status, 200); assert.equal(after.body.status, "completed");
  assert.equal(requests, 2); assert.equal(completed, 2);
  assert.ok(diagnostics.some((entry) => Array.isArray(entry) && String(entry[0]).includes("Failed to proxy")));
});
