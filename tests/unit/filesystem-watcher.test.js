import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../../src/bootstrap/config.js";
import { createFilesystemWatcher } from "../../src/infrastructure/filesystem/watcher.js";

function waitForReady(watcher) {
  return new Promise((resolve) => watcher.once("ready", resolve));
}

function waitForChange(watcher, expectedPath) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedPath}`)), 2000);
    watcher.on("change", (path) => {
      if (path !== expectedPath) return;
      clearTimeout(timer);
      resolve(path);
    });
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("emits raw change for project files and ignores Node-owned directories", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-watcher-"));
  const sourcePath = join(root, "src", "index.js");
  const forgePath = join(root, ".forge", "state.json");
  const dependencyPath = join(root, "node_modules", "dependency", "index.js");
  let watcher;

  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, ".forge"), { recursive: true });
    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await Promise.all([
      writeFile(sourcePath, "export const value = 1;"),
      writeFile(forgePath, "{}"),
      writeFile(dependencyPath, "module.exports = {};" )
    ]);

    watcher = createFilesystemWatcher({ root, chokidarOptions: { interval: 20, usePolling: true } });
    await waitForReady(watcher);

    const sourceChange = waitForChange(watcher, sourcePath);
    await Promise.all([
      writeFile(sourcePath, "export const value = 2;"),
      writeFile(forgePath, '{"changed":true}'),
      writeFile(dependencyPath, "module.exports = { changed: true };" )
    ]);

    assert.equal(await sourceChange, sourcePath);
  } finally {
    await watcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("adds watcherIgnore patterns without hiding normal source files", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-watcher-"));
  const logPath = join(root, "src", "debug.log");
  const sourcePath = join(root, "src", "index.js");
  let watcher;

  try {
    await mkdir(join(root, "src"), { recursive: true });
    await Promise.all([writeFile(logPath, "before\n"), writeFile(sourcePath, "export const value = 1;\n")]);
    const config = loadConfig({ overrides: { watcherIgnore: ["*.log"] } });
    watcher = createFilesystemWatcher({
      root,
      ignore: config.watcherIgnore,
      chokidarOptions: { interval: 20, usePolling: true }
    });
    await waitForReady(watcher);

    const changes = [];
    watcher.on("change", (path) => changes.push(path));
    await writeFile(logPath, "ignored\n");
    await wait(200);
    assert.equal(changes.includes(logPath), false);

    const sourceChange = waitForChange(watcher, sourcePath);
    await writeFile(sourcePath, "export const value = 2;\n");
    assert.equal(await sourceChange, sourcePath);
  } finally {
    await watcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps mandatory ignores when watcherIgnore is empty", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-watcher-"));
  const forgePath = join(root, ".forge", "state.json");
  let watcher;

  try {
    await mkdir(join(root, ".forge"), { recursive: true });
    await writeFile(forgePath, "{}\n");
    const config = loadConfig({ overrides: { watcherIgnore: [] } });
    watcher = createFilesystemWatcher({
      root,
      ignore: config.watcherIgnore,
      chokidarOptions: { interval: 20, usePolling: true }
    });
    await waitForReady(watcher);

    const changes = [];
    watcher.on("change", (path) => changes.push(path));
    await writeFile(forgePath, '{"changed":true}\n');
    await wait(200);

    assert.equal(changes.includes(forgePath), false);
  } finally {
    await watcher?.close();
    await rm(root, { recursive: true, force: true });
  }
});
