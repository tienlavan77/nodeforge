// Owns the in-process multi-project catalog and serializes runtime admission and removal.
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { captureRoot, captureAddRoot, assertRoot, preflightSource, prepareStorage, filesystemError } from "./project-filesystem-safety.js";
import { inspectProjectStorage } from "./project-identity-safety.js";
import { createProjectCreateAdmission, openProjectAdmissionStore, assertProjectCreateOwnership } from "./project-create-admission.js";
import { ProjectRegistry } from "./project-registry.js";
import { createProjectCatalog } from "./project-catalog.js";
import { startProjectRuntime } from "./project-runtime.js";
import { createProjectRuntimeDisposal } from "./project-runtime-disposal.js";

// Restores independent project runtimes from global metadata without adding public transport routes.
export async function createProjectLifecycle({ catalogPath, registry = new ProjectRegistry(), startRuntime = startProjectRuntime, runtimeOptions = {}, logger = console, operationStore } = {}) {
  const catalog = await createProjectCatalog({ catalogPath });
  const runtimes = new Map();
  const { registerCleanup, releaseRuntime, isAvailable } = createProjectRuntimeDisposal();
  const startupErrors = [];
  let tail = Promise.resolve();
  let closed = false;
  let closing;
  for (const entry of catalog.list()) {
    try { await activate(entry.root, entry.projectId); } catch (error) {
      logger.error?.("Unable to restore project runtime.", { root: entry.root, error });
      startupErrors.push({ root: entry.root, error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
  }
  return Object.freeze({ create, add, remove, list, get, close, registerCleanup, startupErrors: Object.freeze(startupErrors) });

  // Fences Create through the durable operation store before exclusive directory creation.
  function create(root, options) {
    return enqueue(async () => {
      await catalog.preflight();
      let store;
      try { store = operationStore ?? await openProjectAdmissionStore(catalogPath); } catch (error) {
        throw filesystemError("operation_store", "operation_store_unwritable", dirname(catalogPath), error);
      }
      return createProjectCreateAdmission({ store, admit })(root, options);
    });
  }

  // Canonicalizes roots so symlinks and relative aliases cannot start duplicate watchers.
  async function canonicalRoot(root) {
    const canonical = await realpath(resolve(root));
    if (!(await stat(canonical)).isDirectory()) throw new Error("Project root must be a directory.");
    return canonical;
  }

  // Serializes lifecycle mutations and preserves the queue after callers observe failures.
  function enqueue(operation) {
    if (closed) return Promise.reject(new Error("Project lifecycle is closed."));
    const result = tail.then(operation);
    tail = result.catch((error) => { logger.error?.("Project lifecycle operation failed.", { error }); });
    return result;
  }

  // Starts a project using its persisted identity and rejects copied identity collisions.
  async function activate(root, expectedProjectId) {
    const canonical = await canonicalRoot(root);
    if (canonical !== root) throw new Error("Stored project root is no longer canonical.");
    const binding = await captureRoot(canonical);
    await preflightSource(binding);
    const projectId = await registry.getOrCreate(canonical, { expectedProjectId, strictIdentity: true, rootBinding: binding });
    await prepareStorage(binding);
    if (expectedProjectId && expectedProjectId !== projectId) throw new Error("Catalog and per-root project identity differ.");
    if (catalog.list().some((entry) => entry.root !== root && entry.projectId === projectId)) {
      throw new Error("Project identity is already registered for another root.");
    }
    await assertRoot(binding);
    await inspectProjectStorage(binding);
    let runtime;
    try { runtime = await startRuntime({ ...runtimeOptions, projectRoot: canonical, projectId, logger }); } catch (error) {
      throw filesystemError("startup", "project_startup_failed", canonical, error, "Membership and identity are retained. Correct the startup failure and retry Add.");
    }
    runtimes.set(canonical, runtime);
    return { root: canonical, projectId };
  }

  // Adds a fully serving runtime, rolling it back if global membership cannot be persisted.
  function add(root) {
    return enqueue(() => admit(root));
  }

  // Commits verified project membership before opening any runtime, watcher, or index.
  async function admit(root, ownedBinding) {
    const binding = ownedBinding ?? await captureAddRoot(root);
    await assertRoot(binding);
    await preflightSource(binding);
    await catalog.preflight();
    if (!ownedBinding) await assertProjectCreateOwnership({ store: operationStore, catalogPath, binding });
    const canonical = binding.root;
    const persisted = catalog.list().find((entry) => entry.root === canonical);
    let projectId;
    try { projectId = await registry.getOrCreate(canonical, { expectedProjectId: persisted?.projectId, strictIdentity: true, rootBinding: binding }); } catch (error) {
      if (error.stage) throw error;
      throw filesystemError("identity", "identity_conflict", canonical, error, "Reconcile catalog and per-root metadata; do not rewrite identity.");
    }
    if (persisted && persisted.projectId !== projectId) throw filesystemError("identity", "identity_conflict", canonical, new Error("Catalog and per-root project identity differ."));
    if (catalog.list().some((entry) => entry.root !== canonical && entry.projectId === projectId)) {
      throw filesystemError("identity", "identity_conflict", canonical, null, "This identity is already registered at another root.");
    }
    await assertRoot(binding);
    await inspectProjectStorage(binding);
    const existing = runtimes.get(canonical);
    if (existing) return { root: canonical, projectId };
    const entry = { root: canonical, projectId };
    if (!persisted) await catalog.replace([...catalog.list(), entry], { guard: () => assertRoot(binding) });
    await assertRoot(binding);
    await activate(canonical, projectId);
    return entry;
  }

  // Removes global membership only after all resources for the project have been released.
  function remove(root) {
    return enqueue(async () => {
      let canonical;
      try { canonical = await canonicalRoot(root); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        canonical = resolve(root);
      }
      const runtime = runtimes.get(canonical);
      if (runtime) {
        await releaseRuntime(runtime);
        runtimes.delete(canonical);
      }
      const entries = catalog.list();
      const found = entries.some((entry) => entry.root === canonical);
      if (found) await catalog.replace(entries.filter((entry) => entry.root !== canonical));
      return Boolean(runtime || found);
    });
  }

  // Lists only projects actually serving in this process, not failed restart entries.
  function list() {
    return closed ? [] : [...runtimes].filter(([, runtime]) => isAvailable(runtime)).map(([root, runtime]) => ({ root, projectId: runtime.projectId }));
  }

  // Gives the Control API composition layer a project-local runtime without replacing request resolution.
  async function get(root) {
    const runtime = runtimes.get(await canonicalRoot(root));
    return !closed && runtime && isAvailable(runtime) ? runtime : undefined;
  }

  // Rejects new admission and drains queued work before stopping every runtime; membership survives restart.
  function close() {
    closed = true;
    closing ??= shutdown();
    return closing;
  }

  // Releases unrelated runtimes even if another project's shutdown reports an error.
  async function shutdown() {
    await tail;
    const results = await Promise.allSettled([...runtimes.values()].map(releaseRuntime));
    runtimes.clear();
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Project lifecycle shutdown failed.");
  }
}

// Creates a normalized HTTP lifecycle error compatible with the public Control API error envelope.
function createLifecycleHttpError(statusCode, code, message, { retryable = false, scope = "scoped", cause } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.statusCode = statusCode;
  error.code = code;
  error.retryable = retryable;
  error.scope = scope;
  return error;
}

// Maps project lifecycle runtime and catalog failures to deterministic Control API HTTP status codes and tokens.
function mapLifecycleError(error, operation = "add") {
  if (error?.statusCode && error?.code && typeof error?.retryable === "boolean" && error?.scope) return error;
  const message = error?.message ?? "Project lifecycle operation failed.";
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || message === "Project root must be a directory.") {
    return createLifecycleHttpError(400, "invalid_lifecycle_root", message, { retryable: false, scope: "field", cause: error });
  }
  if (message === "Project lifecycle is closed.") {
    return createLifecycleHttpError(503, "lifecycle_unavailable", message, { retryable: true, scope: "scoped", cause: error });
  }
  if (
    message === "Catalog and per-root project identity differ." ||
    message === "Project identity is already registered for another root." ||
    message === "Stored project root is no longer canonical."
  ) {
    return createLifecycleHttpError(409, "lifecycle_conflict", message, { retryable: false, scope: "scoped", cause: error });
  }
  const fallbackCode = operation === "remove" && !/catalog|persist|write|replace/i.test(message)
    ? "lifecycle_cleanup_failed"
    : "lifecycle_persistence_failed";
  const code = error?.code === "lifecycle_cleanup_failed" || error?.code === "lifecycle_persistence_failed" ? error.code : fallbackCode;
  return createLifecycleHttpError(500, code, message, { retryable: false, scope: "scoped", cause: error });
}

// Reads and validates the raw request payload for Control API project lifecycle management endpoints.
async function readLifecycleBody(request, { allowEmpty = false } = {}) {
  let raw = "";
  for await (const chunk of request) raw += String(chunk);
  if (allowEmpty) {
    if (raw.trim() !== "") {
      throw createLifecycleHttpError(400, "invalid_lifecycle_root", "GET /lifecycle/list does not accept a request body.", { retryable: false, scope: "field" });
    }
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw createLifecycleHttpError(400, "invalid_lifecycle_root", "Request body must be a JSON object with a single root string.", { retryable: false, scope: "field", cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.root !== "string") {
    throw createLifecycleHttpError(400, "invalid_lifecycle_root", "Request body must contain only a string root field.", { retryable: false, scope: "field" });
  }
  const root = parsed.root.trim();
  if (!root || !isAbsolute(root)) {
    throw createLifecycleHttpError(400, "invalid_lifecycle_root", "Project root must be a non-empty absolute path.", { retryable: false, scope: "field" });
  }
  return root;
}

// Routes bounded multi-project lifecycle management requests (/lifecycle/add, /lifecycle/remove, /lifecycle/list).
export async function routeProjectLifecycle(method, url, request, projectLifecycle) {
  const isList = method === "GET" && url.pathname === "/lifecycle/list";
  const isAdd = method === "POST" && url.pathname === "/lifecycle/add";
  const isRemove = method === "POST" && url.pathname === "/lifecycle/remove";
  if (!isList && !isAdd && !isRemove) return null;
  if (!projectLifecycle) {
    throw createLifecycleHttpError(503, "lifecycle_unavailable", "Project lifecycle management is not configured.", { retryable: true, scope: "scoped" });
  }
  if (isList) {
    if ([...url.searchParams.keys()].length > 0) {
      throw createLifecycleHttpError(400, "invalid_lifecycle_root", "GET /lifecycle/list does not accept query parameters.", { retryable: false, scope: "field" });
    }
    await readLifecycleBody(request, { allowEmpty: true });
    return {
      status: 200,
      body: {
        projects: projectLifecycle.list().map((entry) => ({ root: entry.root, project_id: entry.projectId })),
        startup_errors: (projectLifecycle.startupErrors ?? []).map((entry) => ({
          root: entry.root,
          code: typeof entry.code === "string" && entry.code ? entry.code : "startup_failed",
          message: entry.message ?? entry.error ?? "Project startup failed."
        }))
      }
    };
  }
  const root = await readLifecycleBody(request);
  if (isAdd) {
    try {
      const entry = await projectLifecycle.add(root);
      return { status: 200, body: { project: { root: entry.root, project_id: entry.projectId } } };
    } catch (error) {
      throw mapLifecycleError(error, "add");
    }
  }
  let canonicalOrResolvedRoot;
  try {
    const resolved = await realpath(resolve(root));
    if (!(await stat(resolved)).isDirectory()) {
      throw createLifecycleHttpError(400, "invalid_lifecycle_root", "Project root must be a directory.", { retryable: false, scope: "field" });
    }
    canonicalOrResolvedRoot = resolved;
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.code !== "ENOENT") throw mapLifecycleError(error, "remove");
    canonicalOrResolvedRoot = resolve(root);
  }
  try {
    const removed = await projectLifecycle.remove(canonicalOrResolvedRoot);
    return { status: 200, body: { root: canonicalOrResolvedRoot, removed: Boolean(removed) } };
  } catch (error) {
    throw mapLifecycleError(error, "remove");
  }
}
