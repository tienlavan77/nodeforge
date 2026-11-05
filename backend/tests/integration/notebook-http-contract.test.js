/**
 * Exercises the independent Notebook HTTP contract through the existing Control API
 * composition and a real project-bound SQLite store. The notebook must retain
 * server-owned identity and revision fields, reject malformed writes without
 * changing saved state, and preserve JSON deletion responses and stale-write
 * protection. Authorization isolation has its own mandatory integration suite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createControlApiHttp } from "../../scripts/control-api-http.mjs";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createNotebookStore } from "../../src/modules/projects/notebook-store.js";
import { createPlanOwnerAuth } from "../../src/modules/governance/plan-owner-auth.js";
import { createRoutingApplication, createRoutingStorage } from "./multi-project-request-support.js";

/**
 * Starts the production HTTP composition with an admitted notebook, owner
 * authentication and explicit project permission. Requests use real JSON
 * transport so parsing, route selection and status mapping are observable.
 */
async function createNotebookHttpFixture(context) {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "notebook-http-")));
  const projectId = "PROJECT-HTTP";
  const controlDb = await openIndexDatabase(projectRoot, { storageKind: "control" });
  const notebook = createNotebookStore({ controlDb, projectId });
  const config = { cwd: projectRoot, dataDir: join(projectRoot, ".forge/runtime/nf"), projectId, protocolStorageRoot: ".forge/runtime/protocol-storage" };
  const storage = await createRoutingStorage({ config });
  const application = await createRoutingApplication({ config, storage });
  const runtime = { projectId, projectRoot, controlDb, notebook, status: () => ({ closed: false }) };
  Object.assign(application.services, {
    notebook, controlDb,
    planOwnerAuth: createPlanOwnerAuth({ token: "notebook-http-owner", ownerId: "owner-http" }),
    projectLifecycle: { list: () => [{ root: projectRoot, projectId }], get: async () => runtime }
  });
  const api = createControlApiHttp({
    services: application.services,
    notebookPermissionPort: ({ identity, projectId: selected }) => identity === "owner-http" && selected === projectId
  });
  const server = api.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try { await controlDb.close(); }
    finally { await rm(projectRoot, { recursive: true, force: true }); }
  });
  const origin = `http://127.0.0.1:${server.address().port}/forge/v1/`;
  /** Sends owner-authenticated JSON and checks the transport status before returning the saved record or error. */
  async function request(path, { method = "GET", body, status = 200 } = {}) {
    const response = await fetch(origin + path, {
      method, headers: { authorization: "Bearer notebook-http-owner", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  return { request, notebook, projectId };
}

test("Notebook HTTP creates, filters, reads, patches and deletes independent versioned records", async (context) => {
  const { request, notebook, projectId } = await createNotebookHttpFixture(context);
  const created = await request("notebook", { method: "POST", status: 201, body: { project_id: projectId, content: "  Notebook entry  " } });
  assert.deepEqual(created, notebook.get(created.id));
  assert.deepEqual(Object.keys(created).sort(), ["id", "project_id", "content", "status", "position", "version", "created_at", "updated_at"].sort());
  assert.equal(typeof created.id, "string");
  assert.ok(created.id.length);
  assert.equal(created.project_id, projectId);
  assert.equal(created.content, "  Notebook entry  ");
  assert.equal(created.status, "open");
  assert.equal(created.position, 0);
  assert.equal(created.version, 1);
  assert.ok(Number.isFinite(Date.parse(created.created_at)));
  assert.ok(Number.isFinite(Date.parse(created.updated_at)));
  assert.deepEqual(await request(`notebook/${created.id}`), created);
  assert.deepEqual(await request(`notebook?project_id=${projectId}`), [created]);
  assert.deepEqual(await request(`notebook?project_id=${projectId}&status=open`), [created]);
  const done = await request(`notebook/${created.id}`, { method: "PATCH", body: { status: "done", expected_version: 1 } });
  assert.equal(done.version, 2);
  assert.equal(done.status, "done");
  assert.equal(done.content, created.content);
  assert.equal(done.created_at, created.created_at);
  assert.deepEqual(await request(`notebook?project_id=${projectId}`), []);
  assert.deepEqual(await request(`notebook?project_id=${projectId}&status=done`), [done]);
  assert.deepEqual(await request(`notebook?project_id=${projectId}&status=all`), [done]);
  const edited = await request(`notebook/${created.id}`, { method: "PATCH", body: { content: "Edited", expected_version: 2 } });
  assert.equal(edited.version, 3);
  assert.equal(edited.status, "done");
  assert.equal(edited.content, "Edited");
  const both = await request(`notebook/${created.id}`, { method: "PATCH", body: { content: "Reopened", status: "open", expected_version: 3 } });
  assert.equal(both.version, 4);
  assert.equal(both.status, "open");
  assert.equal(both.content, "Reopened");
  await request(`notebook/${created.id}`, { method: "PATCH", status: 409, body: { content: "Stale", expected_version: 3 } });
  await request(`notebook/${created.id}`, { method: "DELETE", status: 409, body: { expected_version: 3 } });
  assert.deepEqual(notebook.get(created.id), both);
  const deleted = await request(`notebook/${created.id}`, { method: "DELETE", body: { expected_version: 4 } });
  assert.deepEqual(deleted, { deleted: true, id: created.id, project_id: projectId });
  assert.equal(notebook.get(created.id), undefined);
  await request(`notebook/${created.id}`, { status: 404 });
  await request("notebook/missing", { status: 404 });
  await request("notebook/missing", { method: "PATCH", status: 404, body: { content: "Absent", expected_version: 1 } });
  await request("notebook/missing", { method: "DELETE", status: 404, body: { expected_version: 1 } });
});

test("Notebook HTTP rejects invalid collection input and server-owned creation fields", async (context) => {
  const { request, notebook, projectId } = await createNotebookHttpFixture(context);
  for (const path of ["notebook", "notebook?project_id=", `notebook?project=${projectId}`, `notebook?project_id=${projectId}&status=closed`, `notebook?project_id=${projectId}&status=`]) {
    await request(path, { status: 400 });
  }
  for (const body of [null, [], {}, { content: "No project" }, { project_id: "", content: "Empty project" },
    ...[undefined, null, "", " \n\t", 12, {}, []].map((content) => ({ project_id: projectId, content })),
    ...["id", "status", "version", "expected_version", "created_at", "updated_at", "extra"].map((field) => ({ project_id: projectId, content: "Entry", [field]: "client" }))]) {
    await request("notebook", { method: "POST", status: 400, body });
  }
  assert.deepEqual(notebook.list(), []);
});

test("Notebook HTTP rejects malformed patches and revisions without mutating saved state", async (context) => {
  const { request, notebook, projectId } = await createNotebookHttpFixture(context);
  const created = await request("notebook", { method: "POST", status: 201, body: { project_id: projectId, content: "Original" } });
  const path = `notebook/${created.id}`;
  for (const body of [null, [], {}, { expected_version: 1 }, { content: "Missing version" },
    ...[null, "", "1", 0, -1, 1.5, true, {}, []].map((expected_version) => ({ content: "Invalid revision", expected_version })),
    ...[null, "", " \n\t", 3, {}, []].map((content) => ({ content, expected_version: 1 })),
    ...[null, "", "all", "closed", 1, {}, []].map((status) => ({ status, expected_version: 1 })),
    ...[null, "", "0", -1, 1.5, true, {}, []].map((position) => ({ position, expected_version: 1 })),
    ...["id", "version", "created_at", "updated_at", "extra"].map((field) => ({ content: "Invalid field", expected_version: 1, [field]: "client" })),
    { project_id: projectId, content: "Same project forbidden", expected_version: 1 }]) {
    await request(path, { method: "PATCH", status: 400, body });
    assert.deepEqual(notebook.get(created.id), created);
  }
  await request(path, { method: "DELETE", status: 400 });
  for (const expected_version of [null, "", "1", 0, -1, 1.5, true, {}, []]) {
    await request(path, { method: "DELETE", status: 400, body: { expected_version } });
  }
  assert.deepEqual(notebook.get(created.id), created);
});

/**
 * Protects bodyless DELETE clients by exercising query revision validation,
 * stale-write rejection and JSON deletion confirmation through the HTTP server.
 * Every rejected request must leave the complete stored record unchanged.
 */
test("Notebook HTTP validates bodyless DELETE query versions and preserves rejected records", async (context) => {
  const { request, notebook, projectId } = await createNotebookHttpFixture(context);
  const created = await request("notebook", { method: "POST", status: 201, body: { project_id: projectId, content: "Query deletion" } });
  const path = `notebook/${created.id}`;
  for (const query of ["", "?expected_version=", "?expected_version=%20", "?expected_version=invalid",
    "?expected_version=0", "?expected_version=-1", "?expected_version=1.5",
    "?expected_version=Infinity", "?expected_version=9007199254740992"]) {
    await request(path + query, { method: "DELETE", status: 400 });
    assert.deepEqual(notebook.get(created.id), created);
    assert.deepEqual(await request(path), created);
  }
  const updated = await request(path, { method: "PATCH", body: { content: "New revision", expected_version: 1 } });
  await request(path + "?expected_version=1", { method: "DELETE", status: 409 });
  assert.deepEqual(notebook.get(created.id), updated);
  assert.deepEqual(await request(path), updated);
  assert.deepEqual(await request(path + "?expected_version=2", { method: "DELETE" }),
    { deleted: true, id: created.id, project_id: projectId });
  assert.equal(notebook.get(created.id), undefined);
  await request(path, { status: 404 });
});

/**
 * Keeps the notebook limited to its five approved independent endpoints.
 * Retired project nesting, action suffixes and PUT must return route errors
 * without creating records or changing the existing notebook entry.
 */
test("Notebook HTTP rejects project nesting, action routes and PUT without side effects", async (context) => {
  const { request, notebook, projectId } = await createNotebookHttpFixture(context);
  const created = await request("notebook", { method: "POST", status: 201, body: { project_id: projectId, content: "Endpoint guardrails" } });
  for (const path of [`projects/${projectId}/notebook`, `projects/${projectId}/notebook/${created.id}`,
    `notebook/${created.id}/complete`, `notebook/${created.id}/reopen`]) {
    for (const method of ["GET", "POST", "PATCH", "DELETE", "PUT"]) {
      await request(path, { method, status: 404, ...(method === "GET" ? {} : {
        body: { project_id: projectId, content: "Forbidden mutation", status: "done", expected_version: 1 }
      }) });
      assert.deepEqual(notebook.list({ status: "all" }), [created]);
      assert.deepEqual(await request(`notebook/${created.id}`), created);
    }
  }
  for (const path of ["notebook", `notebook/${created.id}`]) {
    await request(path, { method: "PUT", status: 404,
      body: { project_id: projectId, content: "Forbidden replacement", status: "done", expected_version: 1 } });
    assert.deepEqual(notebook.list({ status: "all" }), [created]);
    assert.deepEqual(await request(`notebook/${created.id}`), created);
  }
});

test("Notebook HTTP persists and reorders item positions atomically within the project", async (context) => {
  const { request, projectId } = await createNotebookHttpFixture(context);
  const first = await request("notebook", { method: "POST", status: 201, body: { project_id: projectId, content: "First" } });
  const second = await request("notebook", { method: "POST", status: 201, body: { project_id: projectId, content: "Second" } });
  const third = await request("notebook", { method: "POST", status: 201, body: { project_id: projectId, content: "Third" } });
  assert.deepEqual([first.position, second.position, third.position], [0, 0, 0]);
  const initialList = await request(`notebook?project_id=${projectId}&status=all`);
  assert.deepEqual(initialList.map((i) => ({ id: i.id, position: i.position, status: i.status })), [
    { id: third.id, position: 0, status: "open" },
    { id: second.id, position: 1, status: "open" },
    { id: first.id, position: 2, status: "open" }
  ]);
  const moved = await request(`notebook/${first.id}`, { method: "PATCH", body: { position: 0, status: "done", expected_version: 1 } });
  assert.equal(moved.position, 0);
  assert.equal(moved.status, "done");
  assert.equal(moved.version, 2);
  const all = await request(`notebook?project_id=${projectId}&status=all`);
  assert.deepEqual(all.map((i) => ({ id: i.id, position: i.position, status: i.status })), [
    { id: first.id, position: 0, status: "done" },
    { id: third.id, position: 1, status: "open" },
    { id: second.id, position: 2, status: "open" }
  ]);
});
