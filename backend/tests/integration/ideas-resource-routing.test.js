/**
 * Verifies Ideas HTTP resource routing across the real Control API HTTP composition and admitted-project registry.
 * Exercises collection list/create project resolution, item GET/PATCH/DELETE resolution without project context in the URL or payload, unknown project refusal, isolation from a different default project, and unchanged routing of existing non-Ideas resources.
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

const OWNER_TOKEN = "token-ideas-routing-owner";
const OWNER_ID = "owner-routing-1";

/**
 * Wraps a real project Ideas store with operation counters so tests can prove metadata lookup, content read and mutation happen for the authorized project only.
 */
function createGuardedIdeasStore({ controlDb, projectId }) {
  const base = createIdeasStore({ controlDb, projectId });
  const counters = { locate: 0, list: 0, create: 0, get: 0, update: 0, delete: 0 };
  return Object.freeze({
    projectId,
    counters,
    /** Tallies and forwards metadata-only identifier location. */
    locate(id) {
      counters.locate += 1;
      return base.locate(id);
    },
    /** Tallies and forwards notebook listing. */
    list(options) {
      counters.list += 1;
      return base.list(options);
    },
    /** Tallies and forwards notebook creation. */
    create(input) {
      counters.create += 1;
      return base.create(input);
    },
    /** Tallies and forwards content reads. */
    get(id) {
      counters.get += 1;
      return base.get(id);
    },
    /** Tallies and forwards content mutations. */
    update(id, patch) {
      counters.update += 1;
      return base.update(id, patch);
    },
    /** Tallies and forwards content deletions. */
    delete(id, options) {
      counters.delete += 1;
      return base.delete(id, options);
    }
  });
}

/**
 * Boots the real Control API HTTP server over two admitted projects with PROJECT-B as the default project, injecting a guarded Ideas store and an explicit composition permission port.
 */
async function createIdeasRoutingFixture(context, { permittedProjects = ["PROJECT-A", "PROJECT-B"] } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ideas-routing-")));
  const runtimes = new Map();
  const stores = new Map();
  const controlDbs = new Map();
  const disposal = createProjectRuntimeDisposal();
  const planOwnerAuth = createPlanOwnerAuth({ token: OWNER_TOKEN, ownerId: OWNER_ID });
  const permittedSet = new Set(permittedProjects);

  for (const projectId of ["PROJECT-A", "PROJECT-B"]) {
    const projectRoot = join(base, projectId);
    await mkdir(projectRoot, { recursive: true });
    const controlDb = await openIndexDatabase(projectRoot, { storageKind: "control" });
    const ideas = createGuardedIdeasStore({ controlDb, projectId });
    controlDbs.set(projectId, controlDb);
    stores.set(projectId, ideas);
    let closed = false;
    runtimes.set(projectRoot, {
      projectId,
      projectRoot,
      controlDb,
      ideas,
      status: () => ({ projectId, projectRoot, closed }),
      close: async () => {
        closed = true;
        await controlDb.close();
      }
    });
  }

  const lifecycle = {
    list: () => [...runtimes.values()].filter(disposal.isAvailable).map((runtime) => ({ root: runtime.projectRoot, projectId: runtime.projectId })),
    get: async (root) => runtimes.get(root),
    registerCleanup: disposal.registerCleanup
  };

  /**
   * Composes one root-local application bundle and attaches the matching guarded Ideas store and control database for the admitted project identity.
   */
  async function buildApp({ config, storage }) {
    const built = await createRoutingApplication({ config, storage });
    built.services.planOwnerAuth = planOwnerAuth;
    built.services.ideas = stores.get(config.projectId);
    built.services.controlDb = controlDbs.get(config.projectId);
    return built;
  }

  const defaultRoot = join(base, "PROJECT-B");
  const defaultConfig = {
    cwd: defaultRoot,
    dataDir: join(defaultRoot, ".forge/runtime/nf"),
    projectId: "PROJECT-B",
    protocolStorageRoot: ".forge/runtime/protocol-storage"
  };
  const defaultStorage = await createRoutingStorage({ config: defaultConfig });
  const defaultApplication = await buildApp({ config: defaultConfig, storage: defaultStorage });
  const applications = createProjectApplicationRegistry({
    projectLifecycle: lifecycle,
    defaultApplication,
    defaultRoot,
    createApplication: buildApp,
    createStorage: createRoutingStorage
  });

  const api = createControlApiHttp({
    services: defaultApplication.services,
    resolveProjectServices: applications.resolve,
    ideasPermissionPort: ({ identity, projectId }) => identity === OWNER_ID && permittedSet.has(projectId)
  });

  const server = api.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      await applications.close();
    } finally {
      for (const runtime of runtimes.values()) {
        try { await runtime.close(); } catch (error) { assert.ok(error); }
      }
      await rm(base, { recursive: true, force: true });
    }
  });

  const origin = `http://127.0.0.1:${server.address().port}/forge/v1/`;

  /**
   * Sends an authenticated JSON request through real HTTP transport and asserts the expected status code before returning the parsed body.
   */
  async function request(path, { method = "GET", body, status = 200, token = OWNER_TOKEN } = {}) {
    const headers = { "content-type": "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }

  return { base, origin, request, stores, applications, runtimes, disposal, defaultRoot };
}

test("Ideas item requests resolve and authorize without project context while the default project stays untouched", async (context) => {
  const f = await createIdeasRoutingFixture(context);
  const storeA = f.stores.get("PROJECT-A");
  const storeB = f.stores.get("PROJECT-B");

  const createdA = await f.request("ideas", {
    method: "POST",
    status: 201,
    body: { project_id: "PROJECT-A", content: "Route item without project query" }
  });
  assert.equal(createdA.project_id, "PROJECT-A");
  assert.equal(createdA.status, "open");
  assert.equal(createdA.version, 1);
  assert.equal(storeB.counters.create, 0);

  const missingVersion = await f.request(`ideas/${createdA.id}`, { method: "DELETE", status: 400 });
  assert.equal(missingVersion.error.code, "invalid_idea_version");
  assert.equal(storeA.counters.delete, 0);

  const fetched = await f.request(`ideas/${createdA.id}`, { method: "GET" });
  assert.equal(fetched.id, createdA.id);
  assert.equal(fetched.project_id, "PROJECT-A");
  assert.equal(fetched.content, "Route item without project query");
  assert.equal(storeB.counters.get, 0);
  assert.equal(storeA.counters.get, 1);

  const patched = await f.request(`ideas/${createdA.id}`, {
    method: "PATCH",
    body: { content: "Updated without project_id", status: "done", expected_version: 1 }
  });
  assert.equal(patched.project_id, "PROJECT-A");
  assert.equal(patched.status, "done");
  assert.equal(patched.version, 2);
  assert.equal(storeB.counters.update, 0);

  const listedDoneA = await f.request("ideas?project_id=PROJECT-A&status=done");
  assert.equal(listedDoneA.length, 1);
  assert.equal(listedDoneA[0].id, createdA.id);

  const listedAllB = await f.request("ideas?project_id=PROJECT-B&status=all");
  assert.deepEqual(listedAllB, []);

  await f.request(`ideas/${createdA.id}`, { method: "DELETE", status: 409, body: { expected_version: 1 } });
  assert.equal((await f.request(`ideas/${createdA.id}`)).version, 2);

  const deleted = await f.request(`ideas/${createdA.id}`, { method: "DELETE", body: { expected_version: 2 } });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.project_id, "PROJECT-A");
  assert.equal(storeA.counters.delete, 2);
  assert.equal(storeB.counters.delete, 0);

  await f.request(`ideas/${createdA.id}`, { method: "GET", status: 404 });
});

test("Collection list and create resolve project_id through the admitted registry and never fall back to the default project", async (context) => {
  const f = await createIdeasRoutingFixture(context);
  const storeA = f.stores.get("PROJECT-A");
  const storeB = f.stores.get("PROJECT-B");

  await f.request("ideas", { method: "GET", status: 400 });
  await f.request("ideas?project_id=", { method: "GET", status: 400 });
  await f.request("ideas", { method: "POST", status: 400, body: { content: "Missing project_id" } });

  const unknownGet = await f.request("ideas?project_id=UNKNOWN-PROJECT", { method: "GET", status: 404 });
  assert.equal(unknownGet.error.code, "project_not_found");
  const unknownPost = await f.request("ideas", {
    method: "POST",
    status: 404,
    body: { project_id: "UNKNOWN-PROJECT", content: "Must not use the default PROJECT-B" }
  });
  assert.equal(unknownPost.error.code, "project_not_found");

  assert.equal(storeA.counters.list, 0);
  assert.equal(storeA.counters.create, 0);
  assert.equal(storeB.counters.list, 0);
  assert.equal(storeB.counters.create, 0);
});

test("Default-project isolation holds when an unrelated project is unadmitted while existing routes keep their contract", async (context) => {
  const f = await createIdeasRoutingFixture(context);
  const storeB = f.stores.get("PROJECT-B");
  await f.request("ideas", { method: "POST", status: 201, body: { project_id: "PROJECT-B", content: "Default notebook entry" } });
  assert.equal(storeB.counters.create, 1);

  f.disposal.releaseRuntime(f.runtimes.get(join(f.base, "PROJECT-A")));
  await f.request("ideas?project_id=PROJECT-A", { method: "GET", status: 404 });
  const createdB = await f.request("ideas", { method: "POST", status: 201, body: { project_id: "PROJECT-B", content: "Still admitted" } });
  assert.equal(createdB.project_id, "PROJECT-B");

  await f.request("plans", { method: "GET", status: 400 });
  await f.request("plans?project=UNKNOWN", { method: "GET", status: 404 });
  assert.deepEqual(await f.request("plans?project=PROJECT-B"), []);
  const conv = await f.request("conversations", {
    method: "POST",
    status: 201,
    body: { project: "PROJECT-B", title: "Routing regression check", agent_id: "architecture-manager" }
  });
  assert.equal(conv.project_id, "PROJECT-B");
  assert.equal((await f.request("health", { token: null })).status, "ok");
});
