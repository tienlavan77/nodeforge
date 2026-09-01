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

export async function startProjectWatch({ projectRoot, loggerOptions, chokidarOptions, projectId, projectRegistry = new ProjectRegistry(), logger = console } = {}) {
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
  try {
    const existingFiles = database.all("SELECT COUNT(*) AS count FROM files")[0].count;
    const baselineRebuilt = !databaseExisted || existingFiles === 0;
    const baselineIndexedFiles = baselineRebuilt
      ? (await rebuildIndex({ projectRoot: root, database, ignore: config.watcherIgnore })).indexedFiles
      : 0;

    const fileService = createFileService({ projectRoot: root, watcherIgnore: config.watcherIgnore });
    const indexer = createIncrementalIndexer({ database, projectRoot: root, fileService });
    const rawWatcher = createFilesystemWatcher({
      root,
      ignore: config.watcherIgnore,
      chokidarOptions: { ...chokidarOptions, ignoreInitial: true }
    });
    const ready = once(rawWatcher, "ready");
    const watcher = createDebouncedWatcher({
      rawWatcher,
      projectId: resolvedProjectId,
      root,
      debounceMs: config.watcherDebounceMs,
      renameWindowMs: config.watcherRenameWindowMs
    });
    bootstrap = createBootstrap({ configOptions: { cwd: root }, loggerOptions, watcher, indexer });
    await bootstrap.start();
    await ready;

    let closed = false;
    return Object.freeze({
      projectRoot: root,
      databasePath: database.databasePath,
      baselineRebuilt,
      baselineIndexedFiles,
      async close() {
        if (closed) return;
        closed = true;
        await bootstrap.stop();
        await database.close();
      }
    });
  } catch (error) {
    await bootstrap?.stop();
    await database?.close();
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
  return new Promise((resolveEvent) => emitter.once(event, resolveEvent));
}
