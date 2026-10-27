// Supplies isolated real SQLite fixtures for committed indexing acceptance. Source mutations,
// database faults and parser failures run through production APIs without touching live projects.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";
import { rebuildIndex } from "../../src/modules/index/index-rebuild.js";
export const quiet = { warn() {}, warning() {}, error() {}, info() {}, debug() {} };

// Opens a disposable database with real migrations and exposes production event entrypoints.
// The test owns cleanup, allowing assertions against committed rows after every attempted edit.
export async function indexFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "index-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = await openIndexDatabase(root);
  t.after(() => database.close());
  const indexer = createIncrementalIndexer({ database, projectRoot: root, logger: quiet, projectLogger: () => {} });
  return { root, database, indexer,
    // Writes source exactly as the real watcher would observe it before dispatch.
    write(path, content) { return writeFile(join(root, path), content); },
    // Sends a watcher event and returns its post-transaction result.
    event(path, type = "modified", options = {}) { return indexer.handleDetailed({ type: "watcher.file_" + type, payload: { path }, ...options }); },
    // Runs reconciliation with production scanning while allowing observation callbacks.
    rebuild(options = {}) { return rebuildIndex({ projectRoot: root, database, indexer, ...options }); }
  };
}
