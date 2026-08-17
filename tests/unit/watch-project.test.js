import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { startProjectWatch } from "../../src/modules/watcher/watch-project.js";
import { runCli } from "../../src/transport/cli/index.js";

test("first watch creates the runtime, rebuilds a baseline, and only indexes later changes", async () => {
  await withProject(async (projectRoot) => {
    const sourcePath = await writeProjectFile(projectRoot, "src/example.js", "export function before() {}\n");
    await assert.rejects(access(join(projectRoot, ".forge")));
    const logs = [];
    const watch = await startProjectWatch({
      projectRoot,
      loggerOptions: { sink: { log: (entry) => logs.push(entry) } },
      chokidarOptions: { interval: 20, usePolling: true }
    });

    try {
      assert.equal(watch.baselineRebuilt, true);
      assert.equal(logs.some(({ message }) => message === "Indexed watcher event"), false);
      assert.equal((await readFiles(projectRoot)).length, 1);

      await writeFile(sourcePath, "export function after() {}\n");
      await waitFor(async () => (await readSymbols(projectRoot)).some(({ name }) => name === "after"));
      assert.equal(logs.some(({ message, path }) => message === "Indexed watcher event" && path === "src/example.js"), true);
    } finally {
      await watch.close();
    }
  });
});

test("an existing empty database rebuilds its baseline", async () => {
  await withProject(async (projectRoot) => {
    await writeProjectFile(projectRoot, "src/example.js", "export function stable() {}\n");
    const emptyDatabase = await openIndexDatabase(projectRoot);
    await emptyDatabase.close();

    const emptyWatch = await startProjectWatch({ projectRoot, loggerOptions: quietLogger(), chokidarOptions: polling() });
    assert.equal(emptyWatch.baselineRebuilt, true);
    await emptyWatch.close();
    assert.equal((await readFiles(projectRoot)).length, 1);
  });
});

test("a populated database remains the baseline without replacing file rows", async () => {
  await withProject(async (projectRoot) => {
    await writeProjectFile(projectRoot, "src/example.js", "export function stable() {}\n");
    const seedWatch = await startProjectWatch({ projectRoot, loggerOptions: quietLogger(), chokidarOptions: polling() });
    await seedWatch.close();

    const database = await openIndexDatabase(projectRoot);
    const before = database.all("SELECT file_id, path FROM files");
    await database.close();

    const populatedWatch = await startProjectWatch({ projectRoot, loggerOptions: quietLogger(), chokidarOptions: polling() });
    assert.equal(populatedWatch.baselineRebuilt, false);
    await populatedWatch.close();

    const after = await readFiles(projectRoot);
    assert.deepEqual(after, before);
  });
});

test("closing a project watch releases its watcher handles", async () => {
  await withProject(async (projectRoot) => {
    await writeProjectFile(projectRoot, "src/example.js", "export const value = 1;\n");
    const handlesBefore = new Set(process._getActiveHandles());
    const watch = await startProjectWatch({ projectRoot, loggerOptions: quietLogger(), chokidarOptions: polling() });
    await watch.close();
    await new Promise((resolve) => setImmediate(resolve));

    const leakedHandles = process._getActiveHandles().filter((handle) => !handlesBefore.has(handle));
    assert.deepEqual(leakedHandles, []);
  });
});

test("forge watch accepts an optional path and closes on SIGINT", async () => {
  const signals = new EventEmitter();
  const output = [];
  let closed = false;
  let receivedRoot;
  const running = runCli(["watch", "project"], {
    cwd: "/tmp/nodeforge-cli",
    stdout: { write: (value) => output.push(value) },
    signalEmitter: signals,
    async watchProject({ projectRoot }) {
      receivedRoot = projectRoot;
      return { projectRoot, baselineRebuilt: false, baselineIndexedFiles: 0, close: async () => { closed = true; } };
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  signals.emit("SIGINT");
  assert.equal(await running, 0);
  assert.equal(receivedRoot, "/tmp/nodeforge-cli/project");
  assert.equal(closed, true);
  assert.deepEqual(output, ["Using existing index baseline.\n", "Watching /tmp/nodeforge-cli/project.\n"]);
});

function polling() {
  return { interval: 20, usePolling: true };
}

function quietLogger() {
  return { sink: { log() {} } };
}

async function readFiles(projectRoot) {
  const database = await openIndexDatabase(projectRoot);
  try {
    return database.all("SELECT file_id, path FROM files ORDER BY path");
  } finally {
    await database.close();
  }
}

async function readSymbols(projectRoot) {
  const database = await openIndexDatabase(projectRoot);
  try {
    return database.all("SELECT name FROM symbols");
  } finally {
    await database.close();
  }
}

async function writeProjectFile(projectRoot, path, content) {
  const filePath = join(projectRoot, path);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for watcher indexing.");
}

async function withProject(callback) {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-watch-"));
  try {
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}
