/**
 * Shared multi-project Control API fixture for the independent Notebook boundary.
 * Boots real SQLite storage and application services per admitted project, with
 * proxy counters around governance and execution services.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlApiHttp } from "../../scripts/control-api-http.mjs";
import { createProjectApplicationRegistry } from "../../scripts/control-api-project-applications.mjs";
import { createPlanOwnerAuth } from "../../src/modules/governance/plan-owner-auth.js";
import { createNotebookStore } from "../../src/modules/projects/notebook-store.js";
import { createProjectRuntimeDisposal } from "../../src/modules/projects/project-runtime-disposal.js";
import { createRoutingApplication, createRoutingStorage } from "./multi-project-request-support.js";

/**
 * Starts a local HTTP server backed by real admitted project bundles.
 * Requests traverse the production server, project resolver and Notebook router.
 */
export async function createNotebookVerificationFixture(context, { projectIds = ["PROJECT-A", "PROJECT-B"], permitted = projectIds } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "notebook-verification-")));
  const bundles = new Map();
  const disposal = createProjectRuntimeDisposal();
  const admitted = new Set(projectIds);
  const calls = { approvals: 0, tickets: 0, plans: 0, sprints: 0, agents: 0 };
  const auth = createPlanOwnerAuth({ token: "notebook-verification-owner", ownerId: "owner-verification" });
  /**
   * Wraps every callable port of a named service while forwarding its original
   * behavior, making accidental notebook-triggered work observable to tests.
   */
  function observe(service, category) {
    if (!service) return service;
    return new Proxy({ ...service }, {
      /** Counts service invocations without changing stored records or return values. */
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args) => {
          calls[category] += 1;
          return value.apply(target, args);
        };
      }
    });
  }
  for (const projectId of projectIds) {
    const projectRoot = join(root, projectId);
    await mkdir(projectRoot);
    const config = { cwd: projectRoot, projectId, dataDir: join(projectRoot, ".forge/runtime/nf"), protocolStorageRoot: ".forge/runtime/protocol-storage" };
    const storage = await createRoutingStorage({ config });
    const application = await createRoutingApplication({ config, storage });
    Object.assign(application.services, {
      controlDb: storage.controlDb,
      notebook: createNotebookStore({ controlDb: storage.controlDb, projectId }),
      planOwnerAuth: auth
    });
    for (const [service, category] of Object.entries({
      decisions: "approvals", humanDecisionService: "approvals",
      planStore: "plans", sprintRegistry: "sprints", sprintOrchestration: "sprints",
      directCodeRequest: "tickets", prepareTaskSession: "tickets", agentGateway: "agents"
    })) {
      if (typeof application.services[service] === "function") {
        const original = application.services[service];
        application.services[service] = (...args) => { calls[category] += 1; return original(...args); };
      } else application.services[service] = observe(application.services[service], category);
    }
    bundles.set(projectId, { ...application, config, projectRoot });
  }
  const runtimes = new Map([...bundles.values()].map(bundle => [bundle.projectRoot, {
    ...bundle.services, projectRoot: bundle.projectRoot, status: () => ({ closed: false })
  }]));
  const lifecycle = {
    registerCleanup: disposal.registerCleanup,
    /** Lists only admitted fixture runtimes, matching production project resolution. */
    list: () => [...admitted].map(projectId => ({ projectId, root: bundles.get(projectId).projectRoot })),
    /** Resolves a live project runtime without falling back to the default project. */
    get: async projectRoot => {
      const runtime = runtimes.get(projectRoot);
      return admitted.has(runtime?.projectId) ? runtime : undefined;
    }
  };
  for (const bundle of bundles.values()) bundle.services.projectLifecycle = lifecycle;
  const defaultProject = projectIds.at(-1);
  const defaultApplication = bundles.get(defaultProject);
  const applications = createProjectApplicationRegistry({
    projectLifecycle: lifecycle, defaultApplication, defaultRoot: defaultApplication.projectRoot,
    /** Reuses the actual application created for each admitted fixture project. */
    createApplication: async ({ config }) => bundles.get(config.projectId),
    /** Reuses each project's open storage so registry composition acquires no second process lock. */
    createStorage: async ({ config }) => bundles.get(config.projectId).storage
  });
  const api = createControlApiHttp({
    services: defaultApplication.services, resolveProjectServices: applications.resolve,
    notebookPermissionPort: ({ identity, projectId }) => identity === "owner-verification" && (permitted.includes(projectId) || projectId === "__unlocated_notebook__")
  });
  const server = api.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(async () => {
    await new Promise(resolve => server.close(resolve));
    try {
      await applications.close();
      for (const bundle of bundles.values()) {
        await bundle.storage.controlDb.close();
        await bundle.storage.indexDb?.close();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  const origin = `http://127.0.0.1:${server.address().port}/forge/v1/`;
  /**
   * Sends real JSON requests with optional credentials and asserts the observed
   * status, preserving the backend error body in assertion diagnostics.
   */
  async function request(path, { method = "GET", body, status = 200, token = "notebook-verification-owner" } = {}) {
    const response = await fetch(origin + path, {
      method, headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  return { request, bundles, calls, admitted, defaultProject };
}
