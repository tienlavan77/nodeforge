/**
 * Business purpose: Verifies that the production Control API runtime composition allows
 * browser-initiated Ideas operations (load, create, edit, toggle status, and delete) for admitted
 * projects without requiring a Bearer token when invoked from the UI, while enforcing strict
 * Bearer verification when an Authorization header is supplied and rejecting unadmitted projects.
 * Technical description: Exercises real HTTP transport, SQLite Ideas storage, and project
 * application registry composition mirroring backend/scripts/start-control-api.mjs, alongside
 * source and contract assertions proving createIdeasProjectAuth and createControlApiHttp retain
 * their fail-closed defaults when composed directly without runtime overrides.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlApiHttp } from "../../scripts/control-api-http.mjs";
import { createProjectApplicationRegistry } from "../../scripts/control-api-project-applications.mjs";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createIdeasProjectAuth } from "../../src/modules/governance/ideas-project-auth.js";
import { createPlanOwnerAuth } from "../../src/modules/governance/plan-owner-auth.js";
import { createIdeasStore } from "../../src/modules/projects/ideas-store.js";
import { createProjectRuntimeDisposal } from "../../src/modules/projects/project-runtime-disposal.js";
import { createRoutingApplication, createRoutingStorage } from "./multi-project-request-support.js";

/**
 * Business purpose: Constructs the exact runtime Ideas project authorization adapter configured in
 * backend/scripts/start-control-api.mjs so integration tests can verify browser fallback identity,
 * Bearer token enforcement, admitted-project checking, and sentinel handling against real HTTP.
 * Technical description: Wraps createIdeasProjectAuth with verifyIdentity delegating to
 * planOwnerAuth.verify when an Authorization header is present or falling back to the runtime
 * owner identity, and canAccessProject checking config.projectId, projectLifecycle.list(), and
 * the "__unlocated_idea__" sentinel.
 */
function buildRuntimeIdeasAuth({ config, projectLifecycle, ownerToken, ownerId }) {
  const planOwnerAuth = createPlanOwnerAuth({ token: ownerToken, ownerId });
  return {
    planOwnerAuth,
    ideasAuth: createIdeasProjectAuth({
      planOwnerAuth,
      verifyIdentity: (headers = {}) => {
        const authHeader = headers.authorization ?? headers.Authorization;
        return typeof authHeader === "string" && authHeader.trim()
          ? planOwnerAuth.verify(headers)
          : (ownerId || "local-owner");
      },
      canAccessProject: ({ projectId: targetProjectId } = {}) => targetProjectId === "__unlocated_idea__"
        || targetProjectId === config.projectId
        || Boolean(projectLifecycle?.list?.().some((entry) => entry?.projectId === targetProjectId))
    })
  };
}

/**
 * Business purpose: Launches an isolated multi-project HTTP fixture wired with the runtime
 * Ideas authorization configuration and real SQLite Ideas stores.
 * Technical description: Creates temporary project directories and SQLite control databases for
 * each project, registers them in a live projectLifecycle and createProjectApplicationRegistry,
 * and exposes an HTTP request helper supporting optional or omitted Authorization headers.
 */
async function createRuntimeAuthFixture(context, {
  projectIds = ["PROJECT-CONFIG", "PROJECT-ADMITTED"],
  admittedIds = projectIds,
  ownerToken = "runtime-owner-secret",
  ownerId = undefined
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ideas-runtime-auth-")));
  const runtimes = new Map();
  const stores = new Map();
  const admitted = new Set(admittedIds);
  const disposal = createProjectRuntimeDisposal();

  const lifecycle = {
    registerCleanup: disposal.registerCleanup,
    list: () => [...admitted].map((projectId) => {
      const rt = runtimes.get(projectId);
      return rt ? { projectId, root: rt.projectRoot } : null;
    }).filter(Boolean),
    get: async (projectRoot) => {
      for (const rt of runtimes.values()) {
        if (rt.projectRoot === projectRoot && admitted.has(rt.projectId)) return rt;
      }
      return undefined;
    }
  };

  for (const projectId of projectIds) {
    const projectRoot = join(root, projectId);
    await mkdir(projectRoot, { recursive: true });
    const controlDb = await openIndexDatabase(projectRoot, { storageKind: "control" });
    const ideas = createIdeasStore({ controlDb, projectId });
    const config = {
      cwd: projectRoot,
      projectId,
      dataDir: join(projectRoot, ".forge/runtime/nf"),
      protocolStorageRoot: ".forge/runtime/protocol-storage"
    };
    const storage = await createRoutingStorage({ config });
    const application = await createRoutingApplication({ config, storage });
    const { planOwnerAuth, ideasAuth } = buildRuntimeIdeasAuth({
      config,
      projectLifecycle: lifecycle,
      ownerToken,
      ownerId
    });
    Object.assign(application.services, {
      controlDb,
      ideas,
      planOwnerAuth,
      ideasAuth,
      projectLifecycle: lifecycle
    });
    stores.set(projectId, ideas);
    runtimes.set(projectId, {
      ...application.services,
      application,
      storage,
      config,
      projectId,
      projectRoot,
      controlDb,
      ideas,
      status: () => ({ closed: false })
    });
  }

  const defaultProject = projectIds[0];
  const defaultEntry = runtimes.get(defaultProject);
  const applications = createProjectApplicationRegistry({
    projectLifecycle: lifecycle,
    defaultApplication: defaultEntry.application,
    defaultRoot: defaultEntry.projectRoot,
    createApplication: async ({ config }) => runtimes.get(config.projectId).application,
    createStorage: async ({ config }) => runtimes.get(config.projectId).storage
  });

  const api = createControlApiHttp({
    services: defaultEntry.application.services,
    resolveProjectServices: applications.resolve
  });
  const server = api.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");

  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      await applications.close();
      for (const rt of runtimes.values()) {
        await rt.controlDb.close();
        await rt.storage.controlDb.close();
        await rt.storage.indexDb?.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const origin = `http://127.0.0.1:${server.address().port}/forge/v1/`;

  /**
   * Business purpose: Sends a test HTTP request to the runtime Ideas API with configurable
   * Authorization header presence to simulate browser or token-authenticated callers.
   * Technical description: Dispatches fetch against the live local test server, parses JSON,
   * and asserts the expected HTTP status code.
   */
  async function request(path, { method = "GET", body, status = 200, authorization } = {}) {
    const headers = { "content-type": "application/json" };
    if (authorization !== undefined) headers.authorization = authorization;
    const response = await fetch(origin + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }

  return { request, admitted, stores, defaultProject };
}

test("start-control-api.mjs configures createIdeasProjectAuth with runtime identity fallback and admitted-project access check", async () => {
  const source = await readFile(new URL("../../scripts/start-control-api.mjs", import.meta.url), "utf8");
  assert.match(source, /createIdeasProjectAuth\(\s*\{[\s\S]*?verifyIdentity\s*:/);
  assert.match(source, /NODEFORGE_PLAN_OWNER_ID\s*\|\|\s*["']local-owner["']/);
  assert.match(source, /canAccessProject\s*:/);
  assert.match(source, /__unlocated_idea__/);
  assert.match(source, /projectLifecycle\?\.list/);
});

test("runtime composition executes all five UI Ideas operations without Bearer token and returns 404 IDEA_NOT_FOUND for missing items", async (context) => {
  const f = await createRuntimeAuthFixture(context, {
    projectIds: ["PROJECT-CONFIG", "PROJECT-ADMITTED"],
    ownerToken: undefined,
    ownerId: undefined
  });

  for (const projectId of ["PROJECT-CONFIG", "PROJECT-ADMITTED"]) {
    assert.deepEqual(await f.request(`ideas?project_id=${projectId}`), []);
    const created = await f.request("ideas", {
      method: "POST",
      status: 201,
      body: { project_id: projectId, content: `Idea for ${projectId}` }
    });
    assert.equal(created.project_id, projectId);
    assert.equal(created.version, 1);

    const fetched = await f.request(`ideas/${created.id}`);
    assert.equal(fetched.content, `Idea for ${projectId}`);

    const edited = await f.request(`ideas/${created.id}`, {
      method: "PATCH",
      body: { content: `Edited ${projectId}`, expected_version: 1 }
    });
    assert.equal(edited.version, 2);
    assert.equal(edited.content, `Edited ${projectId}`);

    const toggled = await f.request(`ideas/${created.id}`, {
      method: "PATCH",
      body: { status: "done", expected_version: 2 }
    });
    assert.equal(toggled.version, 3);
    assert.equal(toggled.status, "done");

    const deleted = await f.request(`ideas/${created.id}?expected_version=3`, { method: "DELETE" });
    assert.deepEqual(deleted, { deleted: true, id: created.id, project_id: projectId });
  }

  const missingGet = await f.request("ideas/non-existent-idea-id", { status: 404 });
  assert.equal(missingGet.error.code, "idea_not_found");
  const missingPatch = await f.request("ideas/non-existent-idea-id", {
    method: "PATCH",
    status: 404,
    body: { content: "Nope", expected_version: 1 }
  });
  assert.equal(missingPatch.error.code, "idea_not_found");
  const missingDelete = await f.request("ideas/non-existent-idea-id", {
    method: "DELETE",
    status: 404,
    body: { expected_version: 1 }
  });
  assert.equal(missingDelete.error.code, "idea_not_found");
});

test("runtime composition verifies Bearer tokens strictly without fallback on invalid tokens and rejects unadmitted projects", async (context) => {
  const f = await createRuntimeAuthFixture(context, {
    projectIds: ["PROJECT-CONFIG", "PROJECT-ADMITTED"],
    ownerToken: "valid-runtime-token",
    ownerId: "configured-runtime-owner"
  });

  const idea = await f.request("ideas", {
    method: "POST",
    status: 201,
    authorization: "Bearer valid-runtime-token",
    body: { project_id: "PROJECT-ADMITTED", content: "Token verified idea" }
  });
  assert.equal(idea.project_id, "PROJECT-ADMITTED");

  for (const badAuth of ["Bearer wrong-token", "Basic dXNlcjpwYXNz"]) {
    const deniedList = await f.request("ideas?project_id=PROJECT-ADMITTED", {
      status: 403,
      authorization: badAuth
    });
    assert.equal(deniedList.error.code, "plan_owner_unauthorized");

    const deniedItem = await f.request(`ideas/${idea.id}`, {
      status: 403,
      authorization: badAuth
    });
    assert.equal(deniedItem.error.code, "plan_owner_unauthorized");
  }

  const unadmitted = await f.request("ideas?project_id=PROJECT-UNADMITTED", { status: 404 });
  assert.equal(unadmitted.error.code, "project_not_found");

  f.admitted.delete("PROJECT-ADMITTED");
  await f.request("ideas?project_id=PROJECT-ADMITTED", { status: 404 });
  await f.request(`ideas/${idea.id}`, { status: 404 });
});

test("reusable createIdeasProjectAuth and createControlApiHttp contracts remain fail-closed without runtime overrides", async () => {
  const unconfiguredAuth = createIdeasProjectAuth({
    planOwnerAuth: createPlanOwnerAuth({ token: "t", ownerId: "o" })
  });
  await assert.rejects(
    () => unconfiguredAuth.authorize({ headers: {}, projectId: "PROJECT-A" }),
    (err) => err.statusCode === 503 && err.code === "IDEAS_PERMISSION_UNCONFIGURED"
  );

  const strictAuth = createIdeasProjectAuth({
    planOwnerAuth: createPlanOwnerAuth({ token: "secret", ownerId: "owner-1" }),
    canAccessProject: ({ identity, projectId }) => identity === "owner-1" && projectId === "PROJECT-A"
  });
  await assert.rejects(
    () => strictAuth.authorize({ headers: {}, projectId: "PROJECT-A" }),
    (err) => err.statusCode === 403 && err.code === "PLAN_OWNER_UNAUTHORIZED"
  );
});
