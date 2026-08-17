import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import { createBootstrap } from "../../src/bootstrap/index.js";
import { createFilesystemWatcher } from "../../src/infrastructure/filesystem/watcher.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { rebuildIndex } from "../../src/modules/index/index-rebuild.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";
import { createDebouncedWatcher } from "../../src/modules/watcher/debounced-watcher.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "sample-project");

test("rename preserves the dependency edge and stable file_id through the real watcher pipeline", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-rename-dependency-"));
  let database;
  let bootstrap;

  try {
    await cp(fixtureRoot, projectRoot, { recursive: true });
    database = await openIndexDatabase(projectRoot);
    await rebuildIndex({ projectRoot, database });
    await mkdir(join(projectRoot, "src", "helpers"), { recursive: true });

    const auth = database.all("SELECT file_id FROM files WHERE path = ?", ["src/auth.js"])[0];
    const utils = database.all("SELECT file_id FROM files WHERE path = ?", ["src/utils.js"])[0];
    assert.deepEqual(database.all("SELECT target_file_id, is_broken FROM dependency_edges WHERE source_file_id = ?", [auth.file_id]), [
      { target_file_id: utils.file_id, is_broken: 0 }
    ]);

    const rawWatcher = createFilesystemWatcher({ root: projectRoot, chokidarOptions: { interval: 20, usePolling: true } });
    const watcher = createDebouncedWatcher({ rawWatcher, projectId: "PROJECT-rename-dependency", root: projectRoot });
    const observedEvents = [];
    watcher.on("event", (event) => observedEvents.push(event));
    await once(rawWatcher, "ready");
    await waitFor(() => observedEvents.some(({ payload }) => payload.path === "src/utils.js"));
    bootstrap = createBootstrap({
      configOptions: { cwd: projectRoot },
      watcher,
      indexer: createIncrementalIndexer({ database, projectRoot }),
      loggerOptions: { sink: { log() {} } }
    });
    await bootstrap.start();

    await rename(join(projectRoot, "src", "utils.js"), join(projectRoot, "src", "helpers", "utils.js"));
    await waitFor(
      () => database.all("SELECT path FROM files WHERE file_id = ?", [utils.file_id])[0]?.path === "src/helpers/utils.js",
      2500,
      observedEvents
    );

    assert.deepEqual(database.all("SELECT file_id, path FROM files WHERE file_id = ?", [utils.file_id]), [
      { file_id: utils.file_id, path: "src/helpers/utils.js" }
    ]);
    assert.deepEqual(database.all("SELECT target_file_id, is_broken FROM dependency_edges WHERE source_file_id = ?", [auth.file_id]), [
      { target_file_id: utils.file_id, is_broken: 0 }
    ]);
    assert.equal(observedEvents.some(({ type }) => type === "watcher.file_renamed"), true);
  } finally {
    await bootstrap?.stop();
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function waitFor(predicate, timeoutMs = 2500, events = []) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for the rename event to update index.db: ${events.map((event) => event.type).join(", ")}`);
}
