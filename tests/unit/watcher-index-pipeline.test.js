import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBootstrap } from "../../src/bootstrap/index.js";
import { createFilesystemWatcher } from "../../src/infrastructure/filesystem/watcher.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";
import { createDebouncedWatcher, createNodeEventValidator } from "../../src/modules/watcher/debounced-watcher.js";

test("a filesystem change flows through the internal bus and re-indexes without a manual indexer call", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-watcher-index-"));
  let database;
  let bootstrap;

  try {
    const sourcePath = join(projectRoot, "src", "example.js");
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(sourcePath, "export function oldName() {}\n");
    database = await openIndexDatabase(projectRoot);
    const indexer = createIncrementalIndexer({ database, projectRoot });
    await indexer.handle({ type: "watcher.file_created", payload: { path: "src/example.js" } });

    const rawWatcher = createFilesystemWatcher({ root: projectRoot, chokidarOptions: { interval: 20, usePolling: true } });
    await once(rawWatcher, "ready");
    const watcher = createDebouncedWatcher({ rawWatcher, projectId: "PROJECT-pipeline", root: projectRoot, debounceMs: 100 });
    let validatedEvents = 0;
    const validate = createNodeEventValidator();
    bootstrap = createBootstrap({
      configOptions: { cwd: projectRoot },
      watcher,
      indexer,
      loggerOptions: { sink: { log() {} } },
      validateEvent(event) {
        validatedEvents += 1;
        return validate(event);
      }
    });
    await bootstrap.start();

    await writeFile(sourcePath, "export function newName() {}\n");
    await waitFor(() => database.all("SELECT name FROM symbols").some(({ name }) => name === "newName"));

    assert.deepEqual(database.all("SELECT name FROM symbols"), [{ name: "newName" }]);
    assert.equal(validatedEvents, 1);
  } finally {
    await bootstrap?.stop();
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the watcher-to-index pipeline.");
}
