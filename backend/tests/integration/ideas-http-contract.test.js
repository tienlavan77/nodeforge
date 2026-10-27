/**
 * Exercises the independent Ideas HTTP contract through the existing Control API
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
import { createIdeasStore } from "../../src/modules/projects/ideas-store.js";
import { createPlanOwnerAuth } from "../../src/modules/governance/plan-owner-auth.js";
import { createRoutingApplication, createRoutingStorage } from "./multi-project-request-support.js";

/**
 * Starts the production HTTP composition with an admitted notebook, owner
 * authentication and explicit project permission. Requests use real JSON
 * transport so parsing, route selection and status mapping are observable.
 */
async function createIdeasHttpFixture(context) {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "ideas-http-")));
  const projectId = "PROJECT-HTTP";
  const controlDb = await openIndexDatabase(projectRoot, { storageKind: "control" });
  const ideas = createIdeasStore({ controlDb, projectId });
  const config = { cwd: projectRoot, dataDir: join(projectRoot, ".forge/runtime/nf"), projectId, protocolStorageRoot: ".forge/runtime/protocol-storage" };
  const storage = await createRoutingStorage({ config });
  const application = await createRoutingApplication({ config, storage });
  const runtime = { projectId, projectRoot, controlDb, ideas, status: () => ({ closed: false }) };
  Object.assign(application.services, {
    ideas, controlDb,
    planOwnerAuth: createPlanOwnerAuth({ token: "ideas-http-owner", ownerId: "owner-http" }),
    projectLifecycle: { list: () => [{ root: projectRoot, projectId }], get: async () => runtime }
  });
  const api = createControlApiHttp({
    services: application.services,
    ideasPermissionPort: ({ identity, projectId: selected }) => identity === "owner-http" && selected === projectId
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
      method, headers: { authorization: "Bearer ideas-http-owner", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  return { request, ideas, projectId };
}

test("Ideas HTTP creates, filters, reads, patches and deletes independent versioned records", async (context) => {
  const { request, ideas, projectId } = await createIdeasHttpFixture(context);
  const created = await request("ideas", { method: "POST", status: 201, body: { project_id: projectId, content: "  Notebook entry  " } });
  assert.deepEqual(created, ideas.get(created.id));
  assert.deepEqual(Object.keys(created).sort(), ["id", "project_id", "content", "status", "version", "created_at", "updated_at"].sort());
  assert.equal(typeof created.id, "string");
  assert.ok(created.id.length);
  assert.equal(created.project_id, projectId);
  assert.equal(created.content, "  Notebook entry  ");
  assert.equal(created.status, "open");
  assert.equal(created.version, 1);
  assert.ok(Number.isFinite(Date.parse(created.created_at)));
  assert.ok(Number.isFinite(Date.parse(created.updated_at)));
  assert.deepEqual(await request(`ideas/${created.id}`), created);
  assert.deepEqual(await request(`ideas?project_id=${projectId}`), [created]);
  assert.deepEqual(await request(`ideas?project_id=${projectId}&status=open`), [created]);
  const done = await request(`ideas/${created.id}`, { method: "PATCH", body: { status: "done", expected_version: 1 } });
  assert.equal(done.version, 2);
  assert.equal(done.status, "done");
  assert.equal(done.content, created.content);
  assert.equal(done.created_at, created.created_at);
  assert.deepEqual(await request(`ideas?project_id=${projectId}`), []);
  assert.deepEqual(await request(`ideas?project_id=${projectId}&status=done`), [done]);
  assert.deepEqual(await request(`ideas?project_id=${projectId}&status=all`), [done]);
  const edited = await request(`ideas/${created.id}`, { method: "PATCH", body: { content: "Edited", expected_version: 2 } });
  assert.equal(edited.version, 3);
  assert.equal(edited.status, "done");
  assert.equal(edited.content, "Edited");
  const both = await request(`ideas/${created.id}`, { method: "PATCH", body: { content: "Reopened", status: "open", expected_version: 3 } });
  assert.equal(both.version, 4);
  assert.equal(both.status, "open");
  assert.equal(both.content, "Reopened");
  await request(`ideas/${created.id}`, { method: "PATCH", status: 409, body: { content: "Stale", expected_version: 3 } });
  await request(`ideas/${created.id}`, { method: "DELETE", status: 409, body: { expected_version: 3 } });
  assert.deepEqual(ideas.get(created.id), both);
  const deleted = await request(`ideas/${created.id}`, { method: "DELETE", body: { expected_version: 4 } });
  assert.deepEqual(deleted, { deleted: true, id: created.id, project_id: projectId });
  assert.equal(ideas.get(created.id), undefined);
  await request(`ideas/${created.id}`, { status: 404 });
  await request("ideas/missing", { status: 404 });
  await request("ideas/missing", { method: "PATCH", status: 404, body: { content: "Absent", expected_version: 1 } });
  await request("ideas/missing", { method: "DELETE", status: 404, body: { expected_version: 1 } });
});

test("Ideas HTTP rejects invalid collection input and server-owned creation fields", async (context) => {
  const { request, ideas, projectId } = await createIdeasHttpFixture(context);
  for (const path of ["ideas", "ideas?project_id=", `ideas?project=${projectId}`, `ideas?project_id=${projectId}&status=closed`, `ideas?project_id=${projectId}&status=`]) {
    await request(path, { status: 400 });
  }
  for (const body of [null, [], {}, { content: "No project" }, { project_id: "", content: "Empty project" },
    ...[undefined, null, "", " \n\t", 12, {}, []].map((content) => ({ project_id: projectId, content })),
    ...["id", "status", "version", "expected_version", "created_at", "updated_at", "extra"].map((field) => ({ project_id: projectId, content: "Entry", [field]: "client" }))]) {
    await request("ideas", { method: "POST", status: 400, body });
  }
  assert.deepEqual(ideas.list(), []);
});

test("Ideas HTTP rejects malformed patches and revisions without mutating saved state", async (context) => {
  const { request, ideas, projectId } = await createIdeasHttpFixture(context);
  const created = await request("ideas", { method: "POST", status: 201, body: { project_id: projectId, content: "Original" } });
  const path = `ideas/${created.id}`;
  for (const body of [null, [], {}, { expected_version: 1 }, { content: "Missing version" },
    ...[null, "", "1", 0, -1, 1.5, true, {}, []].map((expected_version) => ({ content: "Invalid revision", expected_version })),
    ...[null, "", " \n\t", 3, {}, []].map((content) => ({ content, expected_version: 1 })),
    ...[null, "", "all", "closed", 1, {}, []].map((status) => ({ status, expected_version: 1 })),
    ...["id", "version", "created_at", "updated_at", "extra"].map((field) => ({ content: "Invalid field", expected_version: 1, [field]: "client" })),
    { project_id: projectId, content: "Same project forbidden", expected_version: 1 }]) {
    await request(path, { method: "PATCH", status: 400, body });
    assert.deepEqual(ideas.get(created.id), created);
  }
  await request(path, { method: "DELETE", status: 400 });
  for (const expected_version of [null, "", "1", 0, -1, 1.5, true, {}, []]) {
    await request(path, { method: "DELETE", status: 400, body: { expected_version } });
  }
  assert.deepEqual(ideas.get(created.id), created);
});
