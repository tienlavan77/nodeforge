import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createIndexConsistencyChecker } from "../../src/modules/index/consistency-checker.js";
import { rebuildIndex } from "../../src/modules/index/index-rebuild.js";
import { runCli } from "../../src/transport/cli/index.js";

test("forge index rebuild restores the file and symbol snapshot after index.db is removed", async () => {
  await withProject(async (projectRoot) => {
    await writeProjectFile(projectRoot, "src/auth.js", "export function login() {}\n");
    await writeProjectFile(projectRoot, "src/main.php", "<?php\nfunction run() {}\n");
    await writeProjectFile(projectRoot, "node_modules/ignored.js", "function ignored() {}\n");
    await writeProjectFile(projectRoot, ".forge/ignored.php", "<?php function ignored() {}\n");

    const firstDatabase = await openIndexDatabase(projectRoot);
    await rebuildIndex({ projectRoot, database: firstDatabase });
    const snapshot = readSnapshot(firstDatabase);
    const databasePath = firstDatabase.databasePath;
    await firstDatabase.close();
    await unlink(databasePath);

    const output = [];
    assert.equal(await runCli(["index", "rebuild"], { cwd: projectRoot, stdout: { write: (value) => output.push(value) } }), 0);
    assert.deepEqual(output, ["Rebuilt index for 2 files.\n"]);

    const rebuiltDatabase = await openIndexDatabase(projectRoot);
    assert.deepEqual(readSnapshot(rebuiltDatabase), snapshot);
    await rebuiltDatabase.close();
  });
});

test("consistency checker emits index.inconsistent and rebuilds when an indexed file is missing", async () => {
  await withProject(async (projectRoot) => {
    await writeProjectFile(projectRoot, "src/auth.js", "export function login() {}\n");
    const database = await openIndexDatabase(projectRoot);
    await rebuildIndex({ projectRoot, database });
    await unlink(join(projectRoot, "src/auth.js"));

    const events = [];
    const checker = createIndexConsistencyChecker({ projectRoot, projectId: "PROJECT-test", database, emit: (event) => events.push(event) });
    const result = await checker.check();

    assert.deepEqual(result, { consistent: false, missingPaths: ["src/auth.js"], rebuilt: 0 });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "index.inconsistent");
    assert.deepEqual(events[0].payload, { missing_paths: ["src/auth.js"] });
    assert.deepEqual(database.all("SELECT path FROM files"), []);
    await database.close();
  });
});

function readSnapshot(database) {
  return {
    files: database.all("SELECT path FROM files ORDER BY path"),
    symbols: database.all("SELECT files.path, symbols.name, symbols.kind FROM symbols JOIN files ON files.file_id = symbols.file_id ORDER BY files.path, symbols.name")
  };
}

async function writeProjectFile(projectRoot, path, content) {
  const filePath = join(projectRoot, path);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function withProject(callback) {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-index-rebuild-"));
  try {
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}
