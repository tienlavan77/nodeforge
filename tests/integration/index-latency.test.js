import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { createBootstrap } from "../../src/bootstrap/index.js";
import { createFilesystemWatcher } from "../../src/infrastructure/filesystem/watcher.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { rebuildIndex } from "../../src/modules/index/index-rebuild.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";
import { createDebouncedWatcher } from "../../src/modules/watcher/debounced-watcher.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "sample-project");

test("updates the index within one second after a real fixture file changes", async (t) => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-index-latency-"));
  let database;
  let bootstrap;

  try {
    await cp(fixtureRoot, projectRoot, { recursive: true });
    database = await openIndexDatabase(projectRoot);
    await rebuildIndex({ projectRoot, database });

    const rawWatcher = createFilesystemWatcher({ root: projectRoot, chokidarOptions: { interval: 20, usePolling: true } });
    await once(rawWatcher, "ready");
    const watcher = createDebouncedWatcher({ rawWatcher, projectId: "PROJECT-index-latency", root: projectRoot });
    bootstrap = createBootstrap({
      configOptions: { cwd: projectRoot },
      watcher,
      indexer: createIncrementalIndexer({ database, projectRoot }),
      loggerOptions: { sink: { log() {} } }
    });
    await bootstrap.start();

    const authPath = join(projectRoot, "src", "auth.js");
    const startedAt = performance.now();
    await writeFile(authPath, "export function login() {\n  return true;\n}\n\nexport function refreshSession() {\n  return false;\n}\n");
    await waitForSymbol(database, "refreshSession");
    const elapsedMs = performance.now() - startedAt;

    t.diagnostic(`file-to-index latency: ${elapsedMs.toFixed(1)}ms`);
    assert.ok(elapsedMs < 1000, `Expected file-to-index latency below 1000ms, received ${elapsedMs.toFixed(1)}ms.`);
  } finally {
    await bootstrap?.stop();
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function waitForSymbol(database, symbolName, timeoutMs = 1000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (database.all("SELECT symbol_id FROM symbols WHERE name = ?", [symbolName]).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${symbolName} in index.db.`);
}
