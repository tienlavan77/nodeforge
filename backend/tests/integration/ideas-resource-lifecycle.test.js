/**
 * Verifies Ideas resource lifecycle behavior across backend restarts, runtime closure during resolution, project removal and re-admission without reusing closed stores, derived location cache invalidation, and unavailable authorization configuration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createControlApiHttp } from "../../scripts/control-api-http.mjs";
import { createProjectApplicationRegistry } from "../../scripts/control-api-project-applications.mjs";
import { createProjectRuntimeDisposal } from "../../src/modules/projects/project-runtime-disposal.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createIdeasStore } from "../../src/modules/projects/ideas-store.js";
import { createPlanOwnerAuth } from "../../src/modules/governance/plan-owner-auth.js";
import { createRoutingApplication, createRoutingStorage } from "./multi-project-request-support.js";

const OWNER_TOKEN = "token-ideas-lifecycle-owner";
const OWNER_ID = "owner-lifecycle-1";

/**
 * Starts a real Control API HTTP server over shared project roots so tests can stop and restart the server (cold cache miss) or remove and re-admit runtimes while tracking closed store reuse.
 */
async function startLifecycleServer({ base, permissionPort = ({ identity, projectId }) => identity === OWNER_ID && ["PROJECT-A", "PROJECT-B"].includes(projectId) } = {}) {
  const runtimes = new Map();
  const stores = new Map();
  const controlDbs = new Map();
  const closedStores = new Set();
  const disposal = createProjectRuntimeDisposal();
  const planOwnerAuth = createPlanOwnerAuth({ token: OWNER_TOKEN, ownerId: OWNER_ID });

  /**
   * Opens a fresh SQLite control database and Ideas store for one project root and registers it in the active runtime map.
   */
  async function openProjectRuntime(projectId) {
    const projectRoot = join(base, projectId);
    await mkdir(projectRoot, { recursive: true });
    const controlDb = await openIndexDatabase(projectRoot, { storageKind: "control" });
    const rawStore = createIdeasStore({ controlDb, projectId });
    let closed = false;
    const store = Object.freeze({
      projectId,
      get isClosed() { return closed; },
      /** Rejects closed-store reuse during metadata lookup and delegates to the open store. */
      locate(id) { if (closed) throw new Error(`Closed Ideas store reused for ${projectId}`); return rawStore.locate(id); },
      /** Rejects closed-store reuse during list and delegates to the open store. */
      list(options) { if (closed) throw new Error(`Closed Ideas store reused for ${projectId}`); return rawStore.list(options); },
      /** Rejects closed-store reuse during create and delegates to the open store. */
      create(input) { if (closed) throw new Error(`Closed Ideas store reused for ${projectId}`); return rawStore.create(input); },
      /** Rejects closed-store reuse during get and delegates to the open store. */
      get(id) { if (closed) throw new Error(`Closed Ideas store reused for ${projectId}`); return rawStore.get(id); },
      /** Rejects closed-store reuse during update and delegates to the open store. */
      update(id, patch) { if (closed) throw new Error(`Closed Ideas store reused for ${projectId}`); return rawStore.update(id, patch); },
      /** Rejects closed-store reuse during delete and delegates to the open store. */
      delete(id, options) { if (closed) throw new Error(`Closed Ideas store reused for ${projectId}`); return rawStore.delete(id, options); }
    });
    controlDbs.set(projectId, controlDb);
    stores.set(projectId, store);
    const runtime = {
      projectId, projectRoot, controlDb, ideas: store,
      status: () => ({ projectId, projectRoot, closed }),
      close: async () => { if (closed) return; closed = true; closedStores.add(store); await controlDb.close(); }
    };
    runtimes.set(projectRoot, runtime);
    return runtime;
  }

  for (const projectId of ["PROJECT-A", "PROJECT-B"]) await openProjectRuntime(projectId);

  const lifecycle = {
    list: () => [...runtimes.values()].filter(disposal.isAvailable).map((runtime) => ({ root: runtime.projectRoot, projectId: runtime.projectId })),
    get: async (root) => runtimes.get(root),
    registerCleanup: disposal.registerCleanup
  };

  /**
   * Composes a root-local application bound to the current active runtime's Ideas store and controlDb.
   */
  async function buildApp({ config, storage }) {
    const built = await createRoutingApplication({ config, storage });
    built.services.planOwnerAuth = planOwnerAuth;
    built.services.ideas = stores.get(config.projectId);
    built.services.controlDb = controlDbs.get(config.projectId);
    return built;
  }

  const defaultRoot = join(base, "PROJECT-B");
  const defaultConfig = { cwd: defaultRoot, dataDir: join(defaultRoot, ".forge/runtime/nf"), projectId: "PROJECT-B", protocolStorageRoot: ".forge/runtime/protocol-storage" };
  const defaultStorage = await createRoutingStorage({ config: defaultConfig });
  const defaultApplication = await buildApp({ config: defaultConfig, storage: defaultStorage });
  const applications = createProjectApplicationRegistry({ projectLifecycle: lifecycle, defaultApplication, defaultRoot, createApplication: buildApp, createStorage: createRoutingStorage });
  const api = createControlApiHttp({ services: defaultApplication.services, resolveProjectServices: applications.resolve, ideasPermissionPort: permissionPort });
  const server = api.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}/forge/v1/`;

  /**
   * Sends a JSON request to the running server and asserts the HTTP status code.
   */
  async function request(path, { method = "GET", body, status = 200, token = OWNER_TOKEN } = {}) {
    const headers = { "content-type": "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }

  /**
   * Gracefully shuts down the HTTP server, application registry, and all open project runtimes.
   */
  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    try { await applications.close(); } finally {
      for (const runtime of runtimes.values()) { try { await runtime.close(); } catch (error) { assert.ok(error); } }
    }
  }

  return { origin, request, stop, openProjectRuntime, runtimes, stores, controlDbs, closedStores, disposal, applications };
}

test("Cold metadata lookup after backend restart resolves item requests without project context", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ideas-lifecycle-restart-")));
  let instance = await startLifecycleServer({ base });
  context.after(async () => {
    try { await instance?.stop(); } finally { await rm(base, { recursive: true, force: true }); }
  });

  const created = await instance.request("ideas", { method: "POST", status: 201, body: { project_id: "PROJECT-A", content: "Survives cold restart" } });
  assert.equal(created.project_id, "PROJECT-A");

  await instance.stop();
  instance = await startLifecycleServer({ base });

  const afterRestart = await instance.request(`ideas/${created.id}`, { method: "GET", status: 200 });
  assert.equal(afterRestart.id, created.id);
  assert.equal(afterRestart.project_id, "PROJECT-A");
  assert.equal(afterRestart.content, "Survives cold restart");

  const updated = await instance.request(`ideas/${created.id}`, { method: "PATCH", status: 200, body: { content: "Updated after cold cache miss", expected_version: 1 } });
  assert.equal(updated.version, 2);
});

test("Project removal invalidates derived location cache, detects duplicates even after caching, and re-admission never reuses closed stores", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ideas-lifecycle-readmit-")));
  const instance = await startLifecycleServer({ base });
  context.after(async () => {
    try { await instance.stop(); } finally { await rm(base, { recursive: true, force: true }); }
  });

  const created = await instance.request("ideas", { method: "POST", status: 201, body: { project_id: "PROJECT-A", content: "Before removal" } });
  const firstStore = instance.stores.get("PROJECT-A");
  const fetchedBefore = await instance.request(`ideas/${created.id}`, { method: "GET", status: 200 });
  assert.equal(fetchedBefore.id, created.id);

  instance.controlDbs.get("PROJECT-B").run("INSERT INTO ideas (id, project_id, content, status, created_at, updated_at, version) VALUES (?, ?, ?, 'open', '2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z', 1)", [created.id, "PROJECT-B", "Duplicate after cache"]);
  await instance.request(`ideas/${created.id}`, { method: "GET", status: 409 });
  instance.controlDbs.get("PROJECT-B").run("DELETE FROM ideas WHERE project_id = ? AND id = ?", ["PROJECT-B", created.id]);

  const rootA = join(base, "PROJECT-A");
  const oldRuntime = instance.runtimes.get(rootA);
  await instance.disposal.releaseRuntime(oldRuntime);
  await oldRuntime.close();
  assert.equal(firstStore.isClosed, true);

  await instance.request(`ideas/${created.id}`, { method: "GET", status: 404 });
  await instance.request("ideas?project_id=PROJECT-A", { method: "GET", status: 404 });

  await instance.openProjectRuntime("PROJECT-A");
  const secondStore = instance.stores.get("PROJECT-A");
  assert.notEqual(firstStore, secondStore);
  assert.equal(secondStore.isClosed, false);

  const fetchedAfterReadmit = await instance.request(`ideas/${created.id}`, { method: "GET", status: 200 });
  assert.equal(fetchedAfterReadmit.id, created.id);
  assert.equal(fetchedAfterReadmit.content, "Before removal");

  const patchedAfterReadmit = await instance.request(`ideas/${created.id}`, { method: "PATCH", status: 200, body: { content: "Mutated on re-admitted store", expected_version: 1 } });
  assert.equal(patchedAfterReadmit.content, "Mutated on re-admitted store");
  assert.equal(patchedAfterReadmit.version, 2);
});

test("Runtime closure during resolution and unavailable or malformed authorization configuration fail closed", async (context) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ideas-lifecycle-midclose-")));
  let closeDuringAuth = false;
  let instance;
  instance = await startLifecycleServer({
    base,
    permissionPort: async ({ identity, projectId }) => {
      if (closeDuringAuth && projectId === "PROJECT-A") {
        const rootA = join(base, "PROJECT-A");
        const rt = instance.runtimes.get(rootA);
        await instance.disposal.releaseRuntime(rt);
        await rt.close();
      }
      return identity === OWNER_ID && ["PROJECT-A", "PROJECT-B"].includes(projectId);
    }
  });
  context.after(async () => {
    try { await instance?.stop(); } finally { await rm(base, { recursive: true, force: true }); }
  });

  const created = await instance.request("ideas", { method: "POST", status: 201, body: { project_id: "PROJECT-A", content: "Close mid-request" } });
  closeDuringAuth = true;
  await instance.request(`ideas/${created.id}`, { method: "GET", status: 404 });

  await instance.stop();
  instance = await startLifecycleServer({ base, permissionPort: null });
  const unconfiguredList = await instance.request("ideas?project_id=PROJECT-A", { method: "GET", status: 503 });
  assert.equal(unconfiguredList.error.code, "ideas_permission_unconfigured");
  const unconfiguredItem = await instance.request("ideas/any-id", { method: "GET", status: 503 });
  assert.equal(unconfiguredItem.error.code, "ideas_permission_unconfigured");

  await instance.stop();
  instance = await startLifecycleServer({ base, permissionPort: () => "not-a-boolean" });
  const malformedRes = await instance.request("ideas?project_id=PROJECT-A", { method: "GET", status: 503 });
  assert.equal(malformedRes.error.code, "ideas_permission_unconfigured");
});
