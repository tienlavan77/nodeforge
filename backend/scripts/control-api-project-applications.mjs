// Resolves admitted projects to stable application bundles and drains them with their runtimes.
import { realpath } from "node:fs/promises";
import { readControlApiConfig } from "./control-api-config.mjs";
import { createControlApiStorage } from "./control-api-storage.mjs";
import { createOnWriteVerifier } from "./control-api-file-verification.mjs";
import { createApplicationDisposal } from "./control-api-application-disposal.mjs";

// Registers shared resource-specific cleanup handles used by both legacy shutdown and project removal.
export function registerApplicationDisposal(application, storage) {
  const disposal = storage.disposal ?? createApplicationDisposal();
  storage.disposal = disposal;
  application.workers = (application.workers ?? []).map((worker) => disposal.own(worker, "stop", 10));
  application.codeCache = disposal.own(application.codeCache, "close", 20);
  application.ticketWorkspaceService = disposal.own(application.ticketWorkspaceService, "close", 30);
  storage.indexDb = disposal.own(storage.indexDb, "close", 40);
  storage.controlDb = disposal.own(storage.controlDb, "close", 50);
  storage.processLock = disposal.own(storage.processLock, "release", 60);
  return disposal;
}

// Composes project-local application services without borrowing another project's storage or callbacks.
export function createProjectApplicationRegistry({ projectLifecycle, defaultApplication, defaultRoot, createApplication, createStorage = createControlApiStorage }) {
  const applications = new Map();
  if (projectLifecycle && defaultApplication?.services && !defaultApplication.services.projectLifecycle) {
    defaultApplication.services.projectLifecycle = projectLifecycle;
  }
  const defaultDisposal = registerApplicationDisposal(defaultApplication, defaultApplication.storage);
  const defaultCanonical = realpath(defaultRoot);
  let closed = false;
  let defaultAvailable = true;
  let closing;
  return Object.freeze({ resolve, close });

  // Creates a root-local stack using the admitted identity rather than global project environment overrides.
  async function compose(runtime) {
    const config = readControlApiConfig({ cwd: runtime.projectRoot, env: { ...process.env, NODE_CONTROL_DATA_DIR: undefined, NODE_CONTROL_PROJECT_ID: runtime.projectId } });
    let testService;
    const storage = await createStorage({ config, configureLogs: false, onWrite: createOnWriteVerifier({ getTestService: () => testService }) });
    storage.disposal ??= createApplicationDisposal();
    registerApplicationDisposal({}, storage);
    try {
      const application = await createApplication({ config, storage, onTestService: (value) => { testService = value; } });
      const disposal = registerApplicationDisposal(application, storage);
      return { application, disposal };
    } catch (error) {
      try { await storage.disposal.close(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Project application startup and rollback failed.");
      }
      throw error;
    }
  }

  // Maps the public project identity through active catalog entries before retrieving its runtime by root.
  async function resolve(projectId) {
    if (closed) return undefined;
    const entry = projectLifecycle?.list().find((item) => item.projectId === projectId);
    if (!entry) return undefined;
    const runtime = await projectLifecycle.get(entry.root);
    if (!runtime || runtime.projectId !== projectId || runtime.status?.().closed || ["failed", "running"].includes(runtime.status?.().progress?.status)) return undefined;
    const defaultMatches = defaultApplication.services.projectId === projectId && await defaultCanonical === entry.root;
    if (closed || !projectLifecycle.list().some((item) => item.root === entry.root && item.projectId === projectId)) return undefined;
    let record = applications.get(runtime);
    if (!record) {
      const useDefault = defaultAvailable && defaultMatches;
      if (useDefault) defaultAvailable = false;
      const pending = useDefault ? Promise.resolve({ application: defaultApplication, disposal: defaultDisposal }) : compose(runtime);
      record = { pending, disposed: false, closing: undefined };
      applications.set(runtime, record);
      // Invalidates cached services before waiting for pending construction and disposing its resources.
      record.close = () => {
        record.disposed = true;
        record.closing ??= pending.then(({ disposal }) => disposal.close());
        return record.closing;
      };
      if (!projectLifecycle.registerCleanup(runtime, record.close)) await record.close();
    }
    const { application } = await record.pending;
    if (closed || record.disposed || await projectLifecycle.get(entry.root) !== runtime || runtime.status?.().closed || ["failed", "running"].includes(runtime.status?.().progress?.status) ||
        !projectLifecycle.list().some((item) => item.root === entry.root && item.projectId === projectId)) {
      await record.close();
      return undefined;
    }
    record.services ??= { ...application.services,
      ...(runtime.ideas ? { ideas: runtime.ideas } : {}),
      ...(runtime.controlDb ? { controlDb: runtime.controlDb } : {}),
      // Rechecks live admission when cached routers or streams use this service bundle.
      assertAdmission() {
        if (closed || record.disposed || runtime.status?.().closed ||
            ["failed", "running"].includes(runtime.status?.().progress?.status) ||
            !projectLifecycle.list().some((item) => item.root === entry.root && item.projectId === projectId)) {
          throw Object.assign(new Error("Project is unavailable."), { statusCode: 404, code: "PROJECT_NOT_FOUND" });
        }
      }
    };
    record.services.assertAdmission();
    return record.services;
  }

  // Drains catalog bundles and the never-resolved default stack through their shared disposal operations.
  function close() {
    closed = true;
    closing ??= Promise.allSettled([...applications.values()].map((record) => record.close()).concat(defaultDisposal.close())).then((results) => {
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "Project applications shutdown failed.");
    });
    return closing;
  }
}
