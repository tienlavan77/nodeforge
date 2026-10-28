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
import { createIndexProgress } from "../index/index-progress.js";
import { ProjectRegistry } from "../projects/project-registry.js";
import { normalizeProjectComments } from "../projects/project-comment-normalization.js";
import { createDebouncedWatcher } from "./debounced-watcher.js";

const INDEX_RUNTIME_DIR = join(".forge", "runtime", "wc");
const INDEX_DATABASE_PATH = [".forge", "runtime", "wc", "index.db"];

export async function startProjectWatch({ projectRoot, loggerOptions, chokidarOptions, projectId, projectRegistry = new ProjectRegistry(), logger = console, internalBus, prepareDatabase, reconcile = false, onProgress = () => {}, progress = createIndexProgress({ onProgress }), watcherFactory = createFilesystemWatcher, normalizeComments = false, coderNormalizer = null, rejectOnViolation = true, fallbackOnViolation = false } = {}) {
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
    if (baselineRebuilt) {
      progress.stage("comment_normalization");
      if (normalizeComments || typeof coderNormalizer === "function") {
        await normalizeProjectComments({
          projectRoot: root, projectId: resolvedProjectId, database, ignore: config.watcherIgnore,
          coderNormalizer, rejectOnViolation, fallbackOnViolation, force: typeof coderNormalizer === "function",
          internalBus, progress
        });
      }
    }
    const baseline = baselineRebuilt
      ? await rebuildIndex({
        projectRoot: root, database, ignore: config.watcherIgnore, ...resources?.indexOptions, progress,
        onFile(entry) {
          resources?.indexOptions?.onFile?.(entry);
          if (internalBus?.emit && entry.phase === "index" && entry.indexed) {
            internalBus.emit("watcher.indexed", {
              project_id: resolvedProjectId, type: "indexer.indexed", indexed: true,
              timestamp: new Date().toISOString(), payload: { path: entry.path }
            });
          }
        }
      })
      : { indexedFiles: 0, succeeded: true };
    const baselineIndexedFiles = baseline.indexedFiles;
    if (!baseline.succeeded) throw Object.assign(new Error("Required indexing work failed."), { code: "index_failed", progress: baseline.progress });
    if (typeof resources?.runInitialEmbeddings === "function") {
      progress.stage("embedding");
      await resources.runInitialEmbeddings();
    } else if (baselineRebuilt) {
      progress.stage("embedding");
    }
    progress.stage("startup/readiness");

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
    bootstrap = createBootstrap({ configOptions: { cwd: root }, loggerOptions, internalBus, watcher, indexer: {
      // Publishes watcher outcomes through the same commit-aware collector used by baseline work.
      async handle(event) {
        progress.stage("scan/index");
        const result = await indexer.handleDetailed(event);
        progress.result(result);
        progress.reconcile(database);
        progress.stage("startup/readiness");
        progress.finish();
        internalBus?.emit("index.result", result);
        if (result.error && result.marker !== "parse_failed") throw result.error;
        return result.committed;
      }
    } });
    await Promise.all([bootstrap.start(), ready]);
    progress.reconcile(database);
    progress.finish();

    return Object.freeze({
      projectRoot: root,
      databasePath: database.databasePath,
      baselineRebuilt,
      baselineIndexedFiles,
      progress,
      close
    });
  } catch (error) {
    progress.fail(error);
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
