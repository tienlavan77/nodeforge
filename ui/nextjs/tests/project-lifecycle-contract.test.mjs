// Exercises the negotiated UI lifecycle client and bounded proxy against executable backend contracts.
// Tests capture requests and uncertain outcomes instead of relying on source spelling or DOM attribute order.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { lifecycleOptInRoute, routeLifecycleOptIn } from "../../../backend/src/transport/http/project-lifecycle-opt-in.js";
import { proxyControlApi } from "../lib/control-api-proxy.js";
import { submitProjectOperation, reloadOperation, retryProjectOperation, getLifecycleSnapshot, acceptOperation } from "../lib/project-lifecycle-client.js";
import { refreshProjects, selectProject, getProjectSelection } from "../lib/project-selection.js";

// Construct a minimal backend operation with real contract fields for transport and fencing checks.
function operation(key, update = {}) {
  return { operation_id: "OPRO-contract", request_key: key, request_fingerprint: "a".repeat(64), kind: "add", root: "/server/project",
    attempt: 1, revision: 1, stage: "attempted", status: "running", counters: { transitions: 1, attempts: 1 },
    timestamps: { created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T00:00:00Z" }, ...update };
}

for (const [mode, cryptoApi] of [
  ["HTTPS", webcrypto],
  ["HTTP without randomUUID", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }],
  ["browser without crypto", undefined]
]) {
  test(`project submission generates recovery keys on ${mode}`, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const originalFetch = globalThis.fetch;
    const requests = [];
    const root = `/server/${mode.replaceAll(" ", "-")}`;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: cryptoApi });
    globalThis.fetch = async (url, init) => {
      requests.push({ url, ...init });
      if (requests.length === 1) throw new Error("response lost");
      const key = init.method === "POST" ? JSON.parse(init.body).request_key : new URL(url).searchParams.get("request_key");
      return Response.json({ version: "1", operation: operation(key, { root, status: "succeeded" }) });
    };
    try {
      let requestKey;
      await assert.rejects(submitProjectOperation("add", root), (error) => {
        requestKey = error.requestKey;
        assert.equal(typeof requestKey, "string");
        assert.ok(requestKey.length > 0 && requestKey.length <= 256);
        assert.equal(JSON.parse(requests[0].body).request_key, requestKey);
        return true;
      });
      assert.equal(getLifecycleSnapshot().pending[requestKey].root, root);
      await assert.rejects(submitProjectOperation("add", root), /Reload status/);
      assert.equal(requests.length, 1);
      assert.equal((await reloadOperation(requestKey)).request_key, requestKey);
      const next = await submitProjectOperation("create", root);
      assert.notEqual(next.request_key, requestKey);
      assert.equal(requests.length, 3);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
      else delete globalThis.crypto;
      globalThis.fetch = originalFetch;
    }
  });
}

test("accepted backend schema and dispatcher require negotiation and exact methods", async () => {
  const schema = JSON.parse(await readFile(new URL("../../../schemas/project/project-lifecycle-transport.schema.json", import.meta.url)));
  assert.deepEqual(schema.$defs.submit.required, ["root", "request_key"]);
  for (const kind of ["create", "add", "retry"]) assert.equal(lifecycleOptInRoute("POST", "/lifecycle/operations/" + kind), true);
  assert.equal(lifecycleOptInRoute("GET", "/lifecycle/operations/add"), false);
  const request = { headers: {}, async *[Symbol.asyncIterator]() {} };
  await assert.rejects(routeLifecycleOptIn("GET", new URL("http://node/lifecycle/directory"), request, {}), { code: "lifecycle_version_required" });
  const result = await routeLifecycleOptIn("GET", new URL("http://node/lifecycle/directory"),
    { ...request, headers: { "x-nodeforge-lifecycle": "1" } }, { directory: () => [] });
  assert.deepEqual(result.body, { version: "1", projects: [] });
});

test("unknown submission reconciles by the same key; retry and status remain different actions", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, ...init });
    if (init.method === "POST" && !url.endsWith("/retry")) throw new Error("response lost");
    const key = url.includes("request_key=") ? new URL(url).searchParams.get("request_key") : JSON.parse(init.body).request_key;
    return Response.json({ version: "1", operation: operation(key, init.method === "POST" ? { attempt: 2, revision: 2 } : { status: "failed", diagnostic: { message: "old failure" } }) });
  };
  try {
    await assert.rejects(submitProjectOperation("add", "/server/project", "uncertain-key"));
    assert.equal(getLifecycleSnapshot().pending["uncertain-key"].root, "/server/project");
    const failed = await reloadOperation("uncertain-key");
    await retryProjectOperation(failed);
    assert.equal(requests.length, 3);
    assert.equal(requests[0].headers["x-nodeforge-lifecycle"], "1");
    assert.deepEqual(JSON.parse(requests[0].body), { root: "/server/project", request_key: "uncertain-key" });
    assert.equal(requests[1].method, undefined);
    assert.match(requests[1].url, /status\?request_key=uncertain-key$/);
    assert.deepEqual(JSON.parse(requests[2].body), { request_key: "uncertain-key", expected_attempt: 1 });
    acceptOperation(operation("uncertain-key", { attempt: 1, revision: 99, diagnostic: { message: "obsolete" } }));
    assert.equal(getLifecycleSnapshot().operations["uncertain-key"].attempt, 2);
    assert.equal(getLifecycleSnapshot().operations["uncertain-key"].diagnostic, undefined);
  } finally { globalThis.fetch = original; }
});

test("admission survives outages and malformed snapshots but valid removal revokes selection", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ projects: [{ project_id: "PROJECT-contract" }] });
    await refreshProjects({ selectInitial: false }); selectProject("PROJECT-contract");
    const previous = getProjectSelection();
    globalThis.fetch = async () => { throw new Error("outage"); };
    await assert.rejects(refreshProjects());
    assert.equal(getProjectSelection().projectId, previous.projectId);
    assert.equal(getProjectSelection().generation, previous.generation);
    assert.equal(getProjectSelection().stale, true);
    globalThis.fetch = async () => Response.json({});
    await assert.rejects(refreshProjects());
    assert.equal(getProjectSelection().projectId, previous.projectId);
    globalThis.fetch = async () => Response.json({ projects: [] });
    await refreshProjects();
    assert.equal(getProjectSelection().projectId, null);
  } finally { globalThis.fetch = original; }
});

test("proxy forwards negotiated headers and each mutation once, blocks unsupported lifecycle routes", async () => {
  const captured = [];
  const server = createServer((request, response) => {
    captured.push({ method: request.method, path: request.url, version: request.headers["x-nodeforge-lifecycle"] });
    if (request.url.includes("timeout")) return;
    if (request.url.includes("disconnect")) { request.socket.destroy(); return; }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { captured.at(-1).body = body; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ok: true })); });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  try {
    for (const [method, path] of [["POST", ["lifecycle", "operations", "create"]], ["GET", ["lifecycle", "operations", "status"]], ["POST", ["lifecycle", "add"]]]) {
      const body = method === "POST" ? JSON.stringify(path.length === 2 ? { root: "/legacy" } : { root: "/server", request_key: "proxy" }) : undefined;
      const result = await proxyControlApi(new Request("http://ui/control-api/" + path.join("/"), { method, body, headers: { "x-nodeforge-lifecycle": "1" } }), path, { origin });
      assert.equal(result.status, 200); await result.text();
    }
    assert.equal(captured[0].version, "1");
    assert.deepEqual(JSON.parse(captured[2].body), { root: "/legacy" });
    for (const path of [["lifecycle", "filesystem"], ["lifecycle", "operations", "command"], ["lifecycle", "operations", "add"]]) {
      assert.equal((await proxyControlApi(new Request("http://ui", { method: "GET" }), path, { origin })).status, 405);
    }
    for (const query of ["timeout", "disconnect"]) {
      const result = await proxyControlApi(new Request("http://ui?"+query, { method: "POST", body: "{}" }), ["lifecycle", "operations", "add"], { origin, timeoutMs: 25 });
      assert.equal(result.status, query === "timeout" ? 504 : 503); await result.text();
    }
    assert.equal(captured.length, 5);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
