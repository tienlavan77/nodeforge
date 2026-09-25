import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { event, writeProjectFile, withIndexer } from "./incremental-indexer-test-support.js";

test("DELETE removes a file and marks inbound relationships as broken", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/target.js", "export const target = 1;\n");
    await writeProjectFile(projectRoot, "src/consumer.js", "import { target } from './target.js';\nexport { target };\n");
    await indexer.handle(event("watcher.file_created", "src/target.js"));
    await indexer.handle(event("watcher.file_created", "src/consumer.js"));

    const consumer = database.all("SELECT file_id FROM files WHERE path = ?", ["src/consumer.js"])[0];

    await unlink(join(projectRoot, "src/target.js"));
    assert.equal(await indexer.handle(event("watcher.file_deleted", "src/target.js")), true);

    assert.deepEqual(database.all("SELECT file_id FROM files WHERE path = ?", ["src/target.js"]), []);
    assert.deepEqual(database.all("SELECT related_file_id, is_broken FROM imports_exports WHERE file_id = ? AND name = ? AND kind = ?", [consumer.file_id, "target", "named"]), [
      { related_file_id: null, is_broken: 1 }
    ]);
    assert.deepEqual(database.all("SELECT target_file_id, is_broken FROM dependency_edges WHERE source_file_id = ?", [consumer.file_id]), [
      { target_file_id: null, is_broken: 1 }
    ]);
  });
});

test("resolves a JavaScript relative import into a dependency edge", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/auth.js", "export function login() {}\n");
    await writeProjectFile(projectRoot, "src/main.js", "import { login } from './auth.js';\nlogin();\n");
    await indexer.handle(event("watcher.file_created", "src/auth.js"));
    await indexer.handle(event("watcher.file_created", "src/main.js"));

    const auth = database.all("SELECT file_id FROM files WHERE path = ?", ["src/auth.js"])[0];
    const main = database.all("SELECT file_id FROM files WHERE path = ?", ["src/main.js"])[0];
    assert.deepEqual(database.all("SELECT target_file_id, kind, is_broken FROM dependency_edges WHERE source_file_id = ?", [main.file_id]), [
      { target_file_id: auth.file_id, kind: "named", is_broken: 0 }
    ]);
  });
});

test("resolves a PHP require into a dependency edge", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/auth.php", "<?php\nfunction login() {}\n");
    await writeProjectFile(projectRoot, "src/main.php", "<?php\nrequire_once __DIR__ . '/auth.php';\nlogin();\n");
    await indexer.handle(event("watcher.file_created", "src/auth.php"));
    await indexer.handle(event("watcher.file_created", "src/main.php"));

    const auth = database.all("SELECT file_id FROM files WHERE path = ?", ["src/auth.php"])[0];
    const main = database.all("SELECT file_id FROM files WHERE path = ?", ["src/main.php"])[0];
    assert.deepEqual(database.all("SELECT target_file_id, kind, is_broken FROM dependency_edges WHERE source_file_id = ?", [main.file_id]), [
      { target_file_id: auth.file_id, kind: "require", is_broken: 0 }
    ]);
  });
});

test("keeps JavaScript package imports and PHP namespace uses external", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/main.js", "import express from 'express';\nexpress();\n");
    await writeProjectFile(projectRoot, "src/main.php", "<?php\nuse App\\Services\\Auth;\n");
    await indexer.handle(event("watcher.file_created", "src/main.js"));
    await indexer.handle(event("watcher.file_created", "src/main.php"));

    assert.deepEqual(database.all("SELECT source_file_id FROM dependency_edges"), []);
    assert.deepEqual(database.all("SELECT name, related_file_id, is_broken FROM imports_exports ORDER BY name"), [
      { name: "Auth", related_file_id: null, is_broken: 0 },
      { name: "default", related_file_id: null, is_broken: 0 }
    ]);
  });
});

test("resolves a direct call to a symbol in the same file", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/example.js", "function second() {}\nfunction first() {\n  second();\n}\nunknown();\n");
    assert.equal(await indexer.handle(event("watcher.file_created", "src/example.js")), true);

    assert.deepEqual(database.all(`SELECT caller.name AS caller, target.name AS target, calls.line
      FROM calls
      JOIN symbols AS caller ON caller.symbol_id = calls.caller_symbol_id
      JOIN symbols AS target ON target.symbol_id = calls.target_symbol_id`), [
      { caller: "first", target: "second", line: 3 }
    ]);
  });
});

test("resolves a direct call through a JavaScript import", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/auth.js", "export function login() {}\n");
    await writeProjectFile(projectRoot, "src/main.js", "import { login } from './auth.js';\nfunction run() {\n  login();\n}\n");
    await indexer.handle(event("watcher.file_created", "src/auth.js"));
    assert.equal(await indexer.handle(event("watcher.file_created", "src/main.js")), true);

    assert.deepEqual(database.all(`SELECT files.path AS target_path, target.name AS target, caller.name AS caller
      FROM calls
      JOIN symbols AS target ON target.symbol_id = calls.target_symbol_id
      JOIN files ON files.file_id = target.file_id
      JOIN symbols AS caller ON caller.symbol_id = calls.caller_symbol_id`), [
      { target_path: "src/auth.js", target: "login", caller: "run" }
    ]);
  });
});

test("resolves a direct PHP call to a symbol in the same file", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/example.php", "<?php\nfunction second() {}\nfunction first() {\n  second();\n}\n");
    assert.equal(await indexer.handle(event("watcher.file_created", "src/example.php")), true);

    assert.deepEqual(database.all(`SELECT caller.name AS caller, target.name AS target, calls.line
      FROM calls
      JOIN symbols AS caller ON caller.symbol_id = calls.caller_symbol_id
      JOIN symbols AS target ON target.symbol_id = calls.target_symbol_id`), [
      { caller: "first", target: "second", line: 4 }
    ]);
  });
});

test("resolves a direct PHP call through a static require", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/auth.php", "<?php\nfunction login() {}\n");
    await writeProjectFile(projectRoot, "src/main.php", "<?php\nrequire_once __DIR__ . '/auth.php';\nfunction run() {\n  login();\n}\n");
    await indexer.handle(event("watcher.file_created", "src/auth.php"));
    assert.equal(await indexer.handle(event("watcher.file_created", "src/main.php")), true);

    assert.deepEqual(database.all(`SELECT files.path AS target_path, target.name AS target, caller.name AS caller
      FROM calls
      JOIN symbols AS target ON target.symbol_id = calls.target_symbol_id
      JOIN files ON files.file_id = target.file_id
      JOIN symbols AS caller ON caller.symbol_id = calls.caller_symbol_id`), [
      { target_path: "src/auth.php", target: "login", caller: "run" }
    ]);
  });
});

test("DELETE marks PHP require relationships as broken", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/auth.php", "<?php\nclass Auth {}\n");
    await writeProjectFile(projectRoot, "src/main.php", "<?php\nrequire_once __DIR__ . '/auth.php';\n");
    await indexer.handle(event("watcher.file_created", "src/auth.php"));
    await indexer.handle(event("watcher.file_created", "src/main.php"));

    const main = database.all("SELECT file_id FROM files WHERE path = ?", ["src/main.php"])[0];
    await unlink(join(projectRoot, "src/auth.php"));
    assert.equal(await indexer.handle(event("watcher.file_deleted", "src/auth.php")), true);

    assert.deepEqual(database.all("SELECT file_id FROM files WHERE path = ?", ["src/auth.php"]), []);
    assert.deepEqual(database.all("SELECT related_file_id, is_broken FROM imports_exports WHERE file_id = ?", [main.file_id]), [
      { related_file_id: null, is_broken: 1 }
    ]);
  });
});
