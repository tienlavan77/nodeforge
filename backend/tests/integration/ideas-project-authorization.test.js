/**
 * Verifies the production Ideas project-authorization adapter, metadata-before-content ordering, fail-closed refusal states, duplicate identifier conflict handling, contradictory project reference rejection, and zero governance side effects.
 * Counters separately track metadata lookup (locate) versus content access (list, create, get, update, delete) to prove permission checks strictly precede content reads and mutations.
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

const OWNER_TOKEN = "token-ideas-auth-owner";
const OWNER_ID = "owner-auth-1";

/**
 * Wraps a real SQLite-backed Ideas store with distinct metadata lookup and content operation counters plus an event log so tests can verify authorization ordering.
 */
function createInstrumentedIdeasStore({ controlDb, projectId, events }) {
  const base = createIdeasStore({ controlDb, projectId });
  const counters = { metadataLocate: 0, contentRead: 0, contentWrite: 0 };
  return Object.freeze({
    projectId,
    counters,
    base,
    /** Records a metadata-only location probe without touching Idea content fields. */
    locate(id) { counters.metadataLocate += 1; events.push(`locate:${projectId}:${id}`); return base.locate(id); },
    /** Records a collection content read. */
    list(options) { counters.contentRead += 1; events.push(`list:${projectId}`); return base.list(options); },
    /** Records a content creation write. */
    create(input) { counters.contentWrite += 1; events.push(`create:${projectId}`); return base.create(input); },
    /** Records an item content read. */
    get(id) { counters.contentRead += 1; events.push(`get:${projectId}:${id}`); return base.get(id); },
    /** Records an item content update write. */
    update(id, patch) { counters.contentWrite += 1; events.push(`update:${projectId}:${id}`); return base.update(id, patch); },
    /** Records an item content deletion write. */
    delete(id, options) { counters.contentWrite += 1; events.push(`delete:${projectId}:${id}`); return base.delete(id, options); }
  });
}

/**
 * Starts a real Control API HTTP server with configurable identity and project-permission ports plus governance spies to verify fail-closed authorization and zero governance side effects.
 */
async function createAuthorizationFixture(context, { permissionPort, ownerToken = OWNER_TOKEN, ownerId = OWNER_ID } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ideas-auth-")));
  const runtimes = new Map();
  const stores = new Map();
  const controlDbs = new Map();
  const events = [];
  const governanceSpies = { decisions: 0, plans: 0, sprints: 0, tickets: 0, agents: 0 };
  const disposal = createProjectRuntimeDisposal();
  const planOwnerAuth = createPlanOwnerAuth({ token: ownerToken, ownerId });

  for (const projectId of ["PROJECT-A", "PROJECT-B"]) {
    const projectRoot = join(base, projectId);
    await mkdir(projectRoot, { recursive: true });
    const controlDb = await openIndexDatabase(projectRoot, { storageKind: "control" });
    const ideas = createInstrumentedIdeasStore({ controlDb, projectId, events });
    controlDbs.set(projectId, controlDb);
    stores.set(projectId, ideas);
    let closed = false;
    runtimes.set(projectRoot, {
      projectId, projectRoot, controlDb, ideas,
      status: () => ({ projectId, projectRoot, closed }),
      close: async () => { closed = true; await controlDb.close(); }
    });
  }

  const lifecycle = {
    list: () => [...runtimes.values()].filter(disposal.isAvailable).map((runtime) => ({ root: runtime.projectRoot, projectId: runtime.projectId })),
    get: async (root) => runtimes.get(root),
    registerCleanup: disposal.registerCleanup
  };

  /**
   * Composes a root-local application with governance side-effect spies and instrumented Ideas storage.
   */
  async function buildApp({ config, storage }) {
    const built = await createRoutingApplication({ config, storage });
    built.services.planOwnerAuth = planOwnerAuth;
    built.services.ideas = stores.get(config.projectId);
    built.services.controlDb = controlDbs.get(config.projectId);
    const origDecisions = built.services.decisions;
    built.services.decisions = Object.freeze({
      ...origDecisions,
      append: (...args) => { governanceSpies.decisions += 1; return origDecisions.append(...args); }
    });
    built.services.agentGateway = { stream: async function* () { governanceSpies.agents += 1; yield* []; } };
    built.services.dispatchTicket = async () => { governanceSpies.tickets += 1; };
    built.services.dispatchSprint = async () => { governanceSpies.sprints += 1; };
    return built;
  }

  const defaultRoot = join(base, "PROJECT-B");
  const defaultConfig = { cwd: defaultRoot, dataDir: join(defaultRoot, ".forge/runtime/nf"), projectId: "PROJECT-B", protocolStorageRoot: ".forge/runtime/protocol-storage" };
  const defaultStorage = await createRoutingStorage({ config: defaultConfig });
  const defaultApplication = await buildApp({ config: defaultConfig, storage: defaultStorage });
  const applications = createProjectApplicationRegistry({ projectLifecycle: lifecycle, defaultApplication, defaultRoot, createApplication: buildApp, createStorage: createRoutingStorage });

  const wrappedPermissionPort = typeof permissionPort === "function"
    ? (input) => { events.push(`authorize:${input.identity}:${input.projectId}`); return permissionPort(input); }
    : permissionPort;

  const api = createControlApiHttp({ services: defaultApplication.services, resolveProjectServices: applications.resolve, ideasPermissionPort: wrappedPermissionPort });
  const server = api.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try { await applications.close(); } finally {
      for (const runtime of runtimes.values()) { try { await runtime.close(); } catch (error) { assert.ok(error); } }
      await rm(base, { recursive: true, force: true });
    }
  });

  const origin = `http://127.0.0.1:${server.address().port}/forge/v1/`;

  /**
   * Sends an HTTP request to the Ideas endpoint with optional Bearer credentials and verifies the HTTP status code.
   */
  async function request(path, { method = "GET", body, status = 200, token = OWNER_TOKEN } = {}) {
    const headers = { "content-type": "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }

  return { base, origin, request, stores, controlDbs, events, governanceSpies, applications };
}

test("Shipped default composition without permission port fails closed with 503 IDEAS_PERMISSION_UNCONFIGURED before any content access", async (context) => {
  const f = await createAuthorizationFixture(context, { permissionPort: undefined });
  const storeA = f.stores.get("PROJECT-A");
  const seeded = storeA.base.create({ content: "Top secret idea" });

  for (const [path, method, body] of [
    ["ideas?project_id=PROJECT-A", "GET", undefined],
    ["ideas", "POST", { project_id: "PROJECT-A", content: "Blocked create" }],
    [`ideas/${seeded.id}`, "GET", undefined],
    [`ideas/${seeded.id}`, "PATCH", { content: "Blocked patch", expected_version: 1 }],
    [`ideas/${seeded.id}`, "DELETE", { expected_version: 1 }]
  ]) {
    const res = await f.request(path, { method, body, status: 503 });
    assert.equal(res.error.code, "ideas_permission_unconfigured");
    assert.ok(!JSON.stringify(res).includes("Top secret idea"));
  }
  assert.equal(storeA.counters.contentRead, 0);
  assert.equal(storeA.counters.contentWrite, 0);
});

test("Metadata location precedes permission check, permission check strictly precedes content access, and unauthorized projects fail closed without disclosing content", async (context) => {
  const f = await createAuthorizationFixture(context, {
    permissionPort: ({ identity, projectId }) => identity === OWNER_ID && projectId === "PROJECT-A"
  });
  const storeA = f.stores.get("PROJECT-A");
  const storeB = f.stores.get("PROJECT-B");
  const ideaA = storeA.base.create({ content: "Authorized A content" });
  const ideaB = storeB.base.create({ content: "Confidential B content" });

  f.events.length = 0;
  const fetchedA = await f.request(`ideas/${ideaA.id}`, { method: "GET", status: 200 });
  assert.equal(fetchedA.content, "Authorized A content");
  const locateIdx = f.events.indexOf(`locate:PROJECT-A:${ideaA.id}`);
  const authIdx = f.events.indexOf(`authorize:${OWNER_ID}:PROJECT-A`);
  const getIdx = f.events.indexOf(`get:PROJECT-A:${ideaA.id}`);
  assert.ok(locateIdx >= 0 && authIdx > locateIdx && getIdx > authIdx);

  f.events.length = 0;
  await f.request(`ideas/${ideaA.id}`, { method: "PATCH", status: 200, body: { content: "Authorized A patch", expected_version: 1 } });
  const patchLocateIdx = f.events.indexOf(`locate:PROJECT-A:${ideaA.id}`);
  const patchAuthIdx = f.events.indexOf(`authorize:${OWNER_ID}:PROJECT-A`);
  const updateIdx = f.events.indexOf(`update:PROJECT-A:${ideaA.id}`);
  assert.ok(patchLocateIdx >= 0 && patchAuthIdx > patchLocateIdx && updateIdx > patchAuthIdx);

  for (const badToken of [null, "wrong-token"]) {
    await f.request("ideas?project_id=PROJECT-A", { method: "GET", token: badToken, status: 403 });
    await f.request(`ideas/${ideaA.id}`, { method: "GET", token: badToken, status: 403 });
  }
  assert.equal(storeA.counters.contentRead, 1);

  const deniedListB = await f.request("ideas?project_id=PROJECT-B", { method: "GET", status: 404 });
  const deniedCreateB = await f.request("ideas", { method: "POST", status: 404, body: { project_id: "PROJECT-B", content: "No write" } });
  const deniedGetB = await f.request(`ideas/${ideaB.id}`, { method: "GET", status: 404 });
  const deniedPatchB = await f.request(`ideas/${ideaB.id}`, { method: "PATCH", status: 404, body: { content: "Tamper", expected_version: 1 } });
  const deniedDeleteB = await f.request(`ideas/${ideaB.id}`, { method: "DELETE", status: 404, body: { expected_version: 1 } });

  for (const errBody of [deniedListB, deniedCreateB, deniedGetB, deniedPatchB, deniedDeleteB]) {
    assert.ok(!JSON.stringify(errBody).includes("Confidential B content"));
  }
  const servicesB = await f.applications.resolve("PROJECT-B");
  assert.doesNotThrow(() => servicesB.assertAdmission());
  assert.ok(storeB.counters.metadataLocate >= 1);
  assert.equal(storeB.counters.contentRead, 0);
  assert.equal(storeB.counters.contentWrite, 0);
  assert.equal(storeB.base.get(ideaB.id).content, "Confidential B content");
});

test("Verified ownerId and active runtime admission never imply project permission when the permission port denies access", async (context) => {
  const f = await createAuthorizationFixture(context, { permissionPort: () => false });
  const storeA = f.stores.get("PROJECT-A");
  const ideaA = storeA.base.create({ content: "Owner identity alone cannot read this" });
  const servicesA = await f.applications.resolve("PROJECT-A");
  assert.doesNotThrow(() => servicesA.assertAdmission());

  await f.request("ideas?project_id=PROJECT-A", { method: "GET", status: 404 });
  await f.request("ideas", { method: "POST", status: 404, body: { project_id: "PROJECT-A", content: "Denied" } });
  const getRes = await f.request(`ideas/${ideaA.id}`, { method: "GET", status: 404 });
  assert.ok(!JSON.stringify(getRes).includes("Owner identity alone cannot read this"));
  assert.equal(storeA.counters.metadataLocate, 1);
  assert.equal(storeA.counters.contentRead, 0);
  assert.equal(storeA.counters.contentWrite, 0);
});

test("Duplicate ideaId across stores returns 409 conflict, contradictory project references are rejected, and CRUD produces zero governance side effects", async (context) => {
  const f = await createAuthorizationFixture(context, {
    permissionPort: ({ identity, projectId }) => identity === OWNER_ID && ["PROJECT-A", "PROJECT-B"].includes(projectId)
  });
  const storeA = f.stores.get("PROJECT-A");
  const storeB = f.stores.get("PROJECT-B");
  const dbA = f.controlDbs.get("PROJECT-A");
  const dbB = f.controlDbs.get("PROJECT-B");

  dbA.run("INSERT INTO ideas (id, project_id, content, status, created_at, updated_at, version) VALUES (?, ?, ?, 'open', '2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z', 1)", ["dup-idea-1", "PROJECT-A", "From A"]);
  dbB.run("INSERT INTO ideas (id, project_id, content, status, created_at, updated_at, version) VALUES (?, ?, ?, 'open', '2026-10-27T00:00:00Z', '2026-10-27T00:00:00Z', 1)", ["dup-idea-1", "PROJECT-B", "From B"]);

  const conflictGet = await f.request("ideas/dup-idea-1", { method: "GET", status: 409 });
  assert.equal(conflictGet.error.code, "idea_project_conflict");
  await f.request("ideas/dup-idea-1", { method: "PATCH", status: 409, body: { content: "Mutate dup", expected_version: 1 } });
  await f.request("ideas/dup-idea-1", { method: "DELETE", status: 409, body: { expected_version: 1 } });
  assert.equal(storeA.counters.contentRead, 0);
  assert.equal(storeB.counters.contentRead, 0);
  assert.equal(storeA.counters.contentWrite, 0);
  assert.equal(storeB.counters.contentWrite, 0);

  const uniqueA = await f.request("ideas", { method: "POST", status: 201, body: { project_id: "PROJECT-A", content: "Bound to A" } });
  await f.request(`ideas/${uniqueA.id}?project_id=PROJECT-B`, { method: "GET", status: 409 });
  await f.request(`ideas/${uniqueA.id}?project=PROJECT-B`, { method: "PATCH", status: 409, body: { content: "Wrong ref", expected_version: 1 } });
  await f.request(`ideas/${uniqueA.id}`, { method: "PATCH", status: 409, body: { project_id: "PROJECT-B", content: "Redirect", expected_version: 1 } });
  await f.request(`ideas/${uniqueA.id}?project_id=PROJECT-B`, { method: "DELETE", status: 409, body: { expected_version: 1 } });
  assert.equal(storeB.counters.contentRead, 0);
  assert.equal(storeB.counters.contentWrite, 0);
  assert.equal(storeA.base.get(uniqueA.id).content, "Bound to A");

  await f.request(`ideas/${uniqueA.id}`, { method: "PATCH", status: 200, body: { content: "Updated A", expected_version: 1 } });
  await f.request(`ideas/${uniqueA.id}`, { method: "DELETE", status: 200, body: { expected_version: 2 } });
  assert.deepEqual(f.governanceSpies, { decisions: 0, plans: 0, sprints: 0, tickets: 0, agents: 0 });
});
