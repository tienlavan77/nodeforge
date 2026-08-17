import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { startProjectWatch } from "../../src/modules/watcher/watch-project.js";

test("isolates two concurrent project pipelines and keeps the other project alive after one closes", async () => {
  const parent = await mkdtemp(join(os.tmpdir(), "nodeforge-project-isolation-"));
  const projectA = join(parent, "project-a");
  const projectB = join(parent, "project-b");
  let watchA;
  let watchB;

  try {
    const sourceA = await writeProjectFile(projectA, "src/a.js", "export function beforeA() {}\n");
    const sourceB = await writeProjectFile(projectB, "src/b.js", "export function beforeB() {}\n");
    watchA = await startProjectWatch({ projectRoot: projectA, loggerOptions: quietLogger(), chokidarOptions: polling() });
    watchB = await startProjectWatch({ projectRoot: projectB, loggerOptions: quietLogger(), chokidarOptions: polling() });

    const initialA = await readSnapshot(projectA);
    const initialB = await readSnapshot(projectB);
    assert.notEqual(await readProjectId(projectA), await readProjectId(projectB));

    await writeFile(sourceA, "export function afterA() {}\n");
    await waitFor(async () => hasSymbol(projectA, "afterA"));
    assert.deepEqual(await readSnapshot(projectB), initialB);
    const afterA = await readSnapshot(projectA);
    assert.notDeepEqual(afterA, initialA);

    await writeFile(sourceB, "export function afterB() {}\n");
    await waitFor(async () => hasSymbol(projectB, "afterB"));
    assert.deepEqual(await readSnapshot(projectA), afterA);
    assert.equal((await readSnapshot(projectB)).symbols.some(({ name }) => name === "afterB"), true);

    await watchA.close();
    watchA = undefined;
    await writeFile(sourceB, "export function afterBSecond() {}\n");
    await waitFor(async () => hasSymbol(projectB, "afterBSecond"));
    assert.equal((await readSnapshot(projectB)).symbols.some(({ name }) => name === "afterBSecond"), true);
  } finally {
    await watchA?.close();
    await watchB?.close();
    await rm(parent, { recursive: true, force: true });
  }
});

function polling() {
  return { interval: 20, usePolling: true };
}

function quietLogger() {
  return { sink: { log() {} } };
}

async function readProjectId(projectRoot) {
  const project = JSON.parse(await readFile(join(projectRoot, ".forge", "runtime", "project.json"), "utf8"));
  return project.project_id;
}

async function readSnapshot(projectRoot) {
  const database = await openIndexDatabase(projectRoot);
  try {
    return {
      files: database.all("SELECT path, file_id FROM files ORDER BY path"),
      symbols: database.all("SELECT files.path, symbols.name FROM symbols JOIN files ON files.file_id = symbols.file_id ORDER BY files.path, symbols.name")
    };
  } finally {
    await database.close();
  }
}

async function hasSymbol(projectRoot, name) {
  const snapshot = await readSnapshot(projectRoot);
  return snapshot.symbols.some((symbol) => symbol.name === name);
}

async function writeProjectFile(projectRoot, path, content) {
  const filePath = join(projectRoot, path);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for isolated project indexing.");
}
