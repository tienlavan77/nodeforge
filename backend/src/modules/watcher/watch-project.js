// Starts the indexed project watcher with incremental indexing bootstrap.
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createBootstrap } from "../../bootstrap/index.js";
import { loadConfig } from "../../bootstrap/config.js";
import { createFilesystemWatcher } from "../../infrastructure/filesystem/watcher.js";
import { createFileService } from "../../infrastructure/filesystem/file-service.js";
import { ensureRuntimeDir, openIndexDatabase } from "../../infrastructure/sqlite/index-database.js";
import { createIncrementalIndexer } from "../index/incremental-indexer.js";
import { rebuildIndex } from "../index/index-rebuild.js";
import { ProjectRegistry } from "../projects/project-registry.js";
import { createDebouncedWatcher } from "./debounced-watcher.js";

const INDEX_RUNTIME_DIR = join(".forge", "runtime", "wc");
const INDEX_DATABASE_PATH = [".forge", "runtime", "wc", "index.db"];

export async function startProjectWatch({ projectRoot, loggerOptions, chokidarOptions, projectId, projectRegistry = new ProjectRegistry(), logger = console, internalBus, prepareDatabase, reconcile = false, watcherFactory = createFilesystemWatcher } = {}) {
  const root = resolve(projectRoot ?? process.cwd());
  const config = loadConfig({ cwd: root });
  const resolvedProjectId = projectId ?? await projectRegistry.getOrCreate(root);
  const databaseExisted = await indexDatabaseExists(root);

  // Explicitly create the runtime directory before the first baseline rebuild.
  if (!databaseExisted) await ensureRuntimeDir(root);

  let database;
  try {
    database = await openIndexDatabase(root, { runtimeDir: INDEX_RUNTIME_DIR });
  } catch (error) {
    logger.error?.("Unable to open project index database", { error: error.message, projectRoot: root });
    throw error;
  }
  let bootstrap;
  let rawWatcher;
  let watcher;
  let ready;
  let resources;
  let closing;
  // Releases every owned resource even if an earlier teardown fails.
  function close() {
    closing ??= closeResources();
    return closing;
  }
  // Stops event admission before draining index work and closing the project database.
  async function closeResources() {
    const errors = [];
    for (const cleanup of [
      () => ready?.cancel?.(),
      () => bootstrap?.stop(),
      () => watcher ? watcher.close() : rawWatcher?.close(),
      () => resources?.close?.(),
      () => database.close()
    ]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Project watcher cleanup failed.");
  }
  try {
    resources = await prepareDatabase?.(database);
    const existingFiles = database.all("SELECT COUNT(*) AS count FROM files")[0].count;
    const baselineRebuilt = reconcile || !databaseExisted || existingFiles === 0;
    const baselineIndexedFiles = baselineRebuilt
      ? (await rebuildIndex({ projectRoot: root, database, ignore: config.watcherIgnore, ...resources?.indexOptions })).indexedFiles
      : 0;

    const fileService = createFileService({ projectRoot: root, watcherIgnore: config.watcherIgnore });
    const indexer = createIncrementalIndexer({ database, projectRoot: root, fileService, ...resources?.indexOptions });
    rawWatcher = watcherFactory({
      root,
      ignore: config.watcherIgnore,
      chokidarOptions: { ...chokidarOptions, ignoreInitial: true }
    });
    ready = once(rawWatcher, "ready");
    watcher = createDebouncedWatcher({
      rawWatcher,
      projectId: resolvedProjectId,
      root,
      debounceMs: config.watcherDebounceMs,
      renameWindowMs: config.watcherRenameWindowMs
    });
    // Reports recoverable watcher errors without stopping other files or projects.
    watcher.on("watcher.error", (error) => {
      logger.error?.("Project watcher event failed.", { projectId: resolvedProjectId, error });
      internalBus?.emit("watcher.error", error);
    });
    bootstrap = createBootstrap({ configOptions: { cwd: root }, loggerOptions, internalBus, watcher, indexer });
    await Promise.all([bootstrap.start(), ready]);

    return Object.freeze({
      projectRoot: root,
      databasePath: database.databasePath,
      baselineRebuilt,
      baselineIndexedFiles,
      close
    });
  } catch (error) {
    try { await close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Project startup and rollback failed.");
    }
    throw error;
  }
}

async function indexDatabaseExists(projectRoot) {
  try {
    await access(join(projectRoot, ...INDEX_DATABASE_PATH));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function once(emitter, event) {
  let cleanup;
  const ready = new Promise((resolveEvent, rejectEvent) => {
    // Removes startup listeners after readiness, failure, or rollback.
    cleanup = () => { emitter.off(event, onReady); emitter.off("error", onError); };
    // Finishes watcher startup when its initial scan is ready.
    function onReady() { cleanup(); resolveEvent(); }
    // Rejects failed startup instead of leaving a partially initialized watcher waiting forever.
    function onError(error) { cleanup(); rejectEvent(error); }
    emitter.once(event, onReady);
    emitter.once("error", onError);
  });
  ready.cancel = cleanup;
  return ready;
}
