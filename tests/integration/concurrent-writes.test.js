import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import { createBootstrap } from "../../src/bootstrap/index.js";
import { createFilesystemWatcher } from "../../src/infrastructure/filesystem/watcher.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";
import { createDebouncedWatcher } from "../../src/modules/watcher/debounced-watcher.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "sample-project");
const FILE_COUNT = 20;

test("indexes twenty concurrent file creates without drops or duplicates", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-concurrent-writes-"));
  let database;
  let bootstrap;

  try {
    await cp(fixtureRoot, projectRoot, { recursive: true });
    await mkdir(join(projectRoot, "src", "feature"), { recursive: true });
    database = await openIndexDatabase(projectRoot);

    const rawWatcher = createFilesystemWatcher({ root: projectRoot, chokidarOptions: { interval: 20, usePolling: true } });
    const watcher = createDebouncedWatcher({ rawWatcher, projectId: "PROJECT-concurrent-writes", root: projectRoot });
    const initialEvents = [];
    watcher.on("event", (event) => initialEvents.push(event));
    await once(rawWatcher, "ready");
    await waitFor(() => initialEvents.some(({ payload }) => payload.path === "src/auth.js") && initialEvents.some(({ payload }) => payload.path === "src/utils.js"));

    bootstrap = createBootstrap({
      configOptions: { cwd: projectRoot },
      watcher,
      indexer: createIncrementalIndexer({ database, projectRoot }),
      loggerOptions: { sink: { log() {} } }
    });
    await bootstrap.start();

    await Promise.all(Array.from({ length: FILE_COUNT }, (_, index) => {
      const number = index + 1;
      return writeFile(join(projectRoot, "src", "feature", `feature-${number}.js`), `export function feature${number}() { return ${number}; }\n`);
    }));
    await waitFor(() => database.all("SELECT path FROM files WHERE path LIKE 'src/feature/%'").length === FILE_COUNT, 5000);

    assert.equal(database.all("SELECT path FROM files").length, FILE_COUNT);
    assert.equal(database.all("SELECT DISTINCT path FROM files WHERE path LIKE 'src/feature/%'").length, FILE_COUNT);
    assert.equal(database.all("SELECT name FROM symbols WHERE name LIKE 'feature%'").length, FILE_COUNT);
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
  throw new Error("Timed out waiting for all concurrent files to be indexed.");
}
