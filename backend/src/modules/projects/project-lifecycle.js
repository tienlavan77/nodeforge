// Owns the in-process multi-project catalog and serializes runtime admission and removal.
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { ProjectRegistry } from "./project-registry.js";
import { createProjectCatalog } from "./project-catalog.js";
import { startProjectRuntime } from "./project-runtime.js";

// Restores independent project runtimes from global metadata without adding public transport routes.
export async function createProjectLifecycle({ catalogPath, registry = new ProjectRegistry(), startRuntime = startProjectRuntime, runtimeOptions = {}, logger = console } = {}) {
  const catalog = await createProjectCatalog({ catalogPath });
  const runtimes = new Map();
  const startupErrors = [];
  let tail = Promise.resolve();
  let closed = false;
  let closing;
  for (const entry of catalog.list()) {
    try { await activate(entry.root, entry.projectId); } catch (error) {
      logger.error?.("Unable to restore project runtime.", { root: entry.root, error });
      startupErrors.push({ root: entry.root, error: error.message });
    }
  }
  return Object.freeze({ add, remove, list, get, close, startupErrors: Object.freeze(startupErrors) });

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
    const projectId = await registry.getOrCreate(canonical);
    if (expectedProjectId && expectedProjectId !== projectId) throw new Error("Catalog and per-root project identity differ.");
    if (catalog.list().some((entry) => entry.root !== root && entry.projectId === projectId)) {
      throw new Error("Project identity is already registered for another root.");
    }
    const runtime = await startRuntime({ ...runtimeOptions, projectRoot: canonical, projectId, logger });
    runtimes.set(canonical, runtime);
    return { root: canonical, projectId };
  }

  // Adds a fully serving runtime, rolling it back if global membership cannot be persisted.
  function add(root) {
    return enqueue(async () => {
      const canonical = await canonicalRoot(root);
      const existing = runtimes.get(canonical);
      if (existing) return { root: canonical, projectId: existing.projectId };
      const persisted = catalog.list().find((entry) => entry.root === canonical);
      const entry = await activate(canonical, persisted?.projectId);
      try {
        await catalog.replace([...catalog.list().filter((item) => item.root !== canonical), entry]);
      } catch (error) {
        const runtime = runtimes.get(canonical);
        runtimes.delete(canonical);
        try { await runtime.close(); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Catalog admission and runtime rollback failed.");
        }
        throw error;
      }
      return entry;
    });
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
        await runtime.close();
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
    return [...runtimes].map(([root, runtime]) => ({ root, projectId: runtime.projectId }));
  }

  // Gives the Control API composition layer a project-local runtime without replacing request resolution.
  async function get(root) {
    return runtimes.get(await canonicalRoot(root));
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
    const results = await Promise.allSettled([...runtimes.values()].map((runtime) => runtime.close()));
    runtimes.clear();
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Project lifecycle shutdown failed.");
  }
}
