// Exercises the negotiated HTTP lifecycle contract before thin-client integration.
// Real backend admission, strict legacy fixtures, operation fencing, retained request keys and
// schema negatives establish that transport metadata cannot grant filesystem ownership or readiness.
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { routeProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";
import { fixture, startLifecycleHttpServer } from "./multi-project-lifecycle-support.js";

// Checks actual response snapshots against the published schema and its operation/progress dependencies.
async function validateResponse(value) {
  const ajv = new Ajv2020({ strict: false, loadSchema: async (uri) => JSON.parse(await readFile(
    new URL("../../../schemas/" + uri.split("/schemas/")[1], import.meta.url), "utf8")) });
  const schema = JSON.parse(await readFile(new URL("../../../schemas/project/project-lifecycle-transport.schema.json", import.meta.url), "utf8"));
  const validate = await ajv.compileAsync(schema);
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}

// Builds realistic incoming requests without bypassing negotiation or JSON content-type validation.
function request(body, headers = {}) {
  return Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]),
    { headers: { "content-type": "application/json", "x-nodeforge-lifecycle": "1", ...headers } });
}

// Polls only read-side status until a backend attempt settles, bounded to avoid hidden mutation retries.
async function settled(lifecycle, key) {
  for (let i = 0; i < 200; i++) {
    const operation = await lifecycle.operations.status(key);
    if (["succeeded", "failed"].includes(operation.status)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Operation did not settle");
}

test("negotiated operations reconcile, retain results and require explicit failed retry", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  let fail = true;
  const lifecycle = await f.open({ startRuntime: async ({ projectId, projectRoot }) => {
    if (fail) throw new Error("private startup detail");
    return { projectId, projectRoot, close() {} };
  } });
  const url = new URL("http://localhost/lifecycle/operations/add");
  const body = { root: f.roots[0], request_key: "add-once" };
  const accepted = await routeProjectLifecycle("POST", url, request(body), lifecycle);
  assert.equal(accepted.status, 202);
  await validateResponse(accepted.body);
  const failed = await settled(lifecycle, body.request_key);
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(JSON.stringify(failed), /private startup detail/);
  const replay = await routeProjectLifecycle("POST", url, request(body), lifecycle);
  assert.equal(replay.body.operation.operation_id, accepted.body.operation.operation_id);
  assert.equal(replay.body.operation.attempt, 1);
  const legacy = await routeProjectLifecycle("GET", new URL("http://localhost/lifecycle/list"), request(), lifecycle);
  assert.deepEqual(legacy.body.projects, []);
  const directory = await routeProjectLifecycle("GET", new URL("http://localhost/lifecycle/directory"), request(), lifecycle);
  assert.equal(directory.body.projects.length, 1);
  await validateResponse(directory.body);
  assert.equal(directory.body.projects[0].readiness, "unavailable");
  fail = false;
  const retry = new URL("http://localhost/lifecycle/operations/retry");
  await routeProjectLifecycle("POST", retry, request({ request_key: body.request_key, expected_attempt: 1 }), lifecycle);
  await assert.rejects(routeProjectLifecycle("POST", retry, request({ request_key: body.request_key, expected_attempt: 1 }), lifecycle), { code: "operation_retry_conflict" });
  const done = await settled(lifecycle, body.request_key);
  assert.equal(done.status, "succeeded");
  await validateResponse({ version: "1", operation: done });
  assert.equal(done.attempt, 2);
  assert.deepEqual((await routeProjectLifecycle("GET", new URL("http://localhost/lifecycle/list"), request(), lifecycle)).body.projects,
    [{ root: f.roots[0], project_id: done.project_id }]);
  await assert.rejects(lifecycle.operations.submit("add", f.roots[1], body.request_key));
});

test("Create retry requires original ownership and never adopts an existing target", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  let fail = true;
  const lifecycle = await f.open({ startRuntime: async ({ projectId, projectRoot }) => {
    if (fail) throw new Error("startup unavailable");
    return { projectId, projectRoot, close() {} };
  } });
  const root = f.roots[0] + "-created";
  await lifecycle.operations.submit("create", root, "create-owned");
  assert.equal((await settled(lifecycle, "create-owned")).status, "failed");
  fail = false;
  await lifecycle.operations.retry("create-owned", 1);
  assert.equal((await settled(lifecycle, "create-owned")).status, "succeeded");
  await lifecycle.operations.submit("create", f.roots[1], "create-existing");
  assert.equal((await settled(lifecycle, "create-existing")).status, "failed");
  await lifecycle.operations.retry("create-existing", 1);
  assert.equal((await settled(lifecycle, "create-existing")).status, "failed");
  assert.equal(lifecycle.list().length, 1);
});

test("strict negotiation, bounded routes and legacy root-only payloads reject unsupported requests", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const lifecycle = await f.open();
  const url = new URL("http://localhost/lifecycle/operations/add");
  await assert.rejects(routeProjectLifecycle("POST", url, request({ root: f.roots[0], request_key: "x" }, { "x-nodeforge-lifecycle": undefined }), lifecycle), { statusCode: 406 });
  await assert.rejects(routeProjectLifecycle("POST", url, request({ root: f.roots[0], request_key: "x", extra: true }), lifecycle), { statusCode: 400 });
  await assert.rejects(routeProjectLifecycle("POST", url, request({ root: f.roots[0], request_key: "x".repeat(9000) }), lifecycle), { statusCode: 413 });
  await assert.rejects(routeProjectLifecycle("POST", url, request({ root: f.roots[0], request_key: "x" }), undefined), { statusCode: 503 });
  await assert.rejects(routeProjectLifecycle("POST", new URL("http://localhost/lifecycle/add"), request({ root: f.roots[0], request_key: "x" }), lifecycle), { code: "invalid_lifecycle_root" });
  assert.equal(await routeProjectLifecycle("PUT", url, request(), lifecycle), null);
  assert.equal(await routeProjectLifecycle("GET", new URL("http://localhost/lifecycle/unknown"), request(), lifecycle), null);
  const server = await startLifecycleHttpServer(lifecycle);
  t.after(server.close);
  const base = server.baseUrl ?? server.url;
  assert.ok(base, "HTTP fixture exposes its server URL");
  const options = await fetch(new URL("/lifecycle/operations/add", base), { method: "OPTIONS", headers: { "access-control-request-method": "POST" } });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-methods"), "POST,OPTIONS");
  assert.match(options.headers.get("access-control-allow-headers"), /x-nodeforge-lifecycle/);
  const unsupported = await fetch(new URL("/lifecycle/operations/add", base), { method: "OPTIONS", headers: { "access-control-request-method": "DELETE" } });
  assert.equal(unsupported.status, 404);
});

test("transport schema accepts strict payloads and rejects legacy expansion and malformed retry", async () => {
  const schema = JSON.parse(await readFile(new URL("../../../schemas/project/project-lifecycle-transport.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false });
  const submit = ajv.compile({ ...schema.$defs.submit, $defs: schema.$defs });
  const retry = ajv.compile({ ...schema.$defs.retry, $defs: schema.$defs });
  assert.equal(submit({ root: "/server-only/project", request_key: "create-1" }), true);
  for (const value of [{ root: "/server" }, { root: "/server", request_key: "x", extra: true }, { root: "relative", request_key: "x" }, { root: "/server", request_key: " " }]) assert.equal(submit(value), false);
  assert.equal(retry({ request_key: "x", expected_attempt: 1 }), true);
  assert.equal(retry({ request_key: "x", expected_attempt: 0 }), false);
  assert.equal(retry({ request_key: "x", expected_attempt: 1, root: "/server" }), false);
});
