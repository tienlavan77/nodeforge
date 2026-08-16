import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";

test("CREATE indexes JavaScript and PHP through the shared extractor registry", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/example.js", "import value from './value.js';\nexport function build() { return value; }\n");
    await writeProjectFile(projectRoot, "src/account.php", "<?php\nclass Account {\n  public function login() {}\n}\n");

    assert.equal(await indexer.handle(event("watcher.file_created", "src/example.js")), true);
    assert.equal(await indexer.handle(event("watcher.file_created", "src/account.php")), true);

    assert.deepEqual(database.all("SELECT path FROM files ORDER BY path"), [{ path: "src/account.php" }, { path: "src/example.js" }]);
    assert.deepEqual(database.all("SELECT name, kind, start_line, end_line FROM symbols ORDER BY name"), [
      { name: "Account", kind: "class", start_line: 2, end_line: 4 },
      { name: "build", kind: "function", start_line: 2, end_line: 2 },
      { name: "login", kind: "method", start_line: 3, end_line: 3 }
    ]);
    assert.deepEqual(database.all("SELECT name, kind, is_broken FROM imports_exports ORDER BY name"), [
      { name: "build", kind: "export:named", is_broken: 0 },
      { name: "default", kind: "default", is_broken: 1 }
    ]);
  });
});

test("MODIFY replaces the indexed symbols for exactly one file", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/example.js", "export function oldName() {}\n");
    await indexer.handle(event("watcher.file_created", "src/example.js"));

    await writeProjectFile(projectRoot, "src/example.js", "export function newName() {}\nexport class NewType {}\n");
    assert.equal(await indexer.handle(event("watcher.file_modified", "src/example.js")), true);

    assert.deepEqual(database.all("SELECT name FROM symbols ORDER BY name"), [{ name: "NewType" }, { name: "newName" }]);
    assert.deepEqual(database.all("SELECT name FROM symbols WHERE name = 'oldName'"), []);
  });
});

test("MODIFY replaces the indexed PHP symbols and imports", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/first.php", "<?php\nclass First {}\n");
    await writeProjectFile(projectRoot, "src/second.php", "<?php\nclass Second {}\n");
    await writeProjectFile(projectRoot, "src/main.php", "<?php\nrequire_once __DIR__ . '/first.php';\nfunction oldName() {}\n");
    await indexer.handle(event("watcher.file_created", "src/first.php"));
    await indexer.handle(event("watcher.file_created", "src/second.php"));
    await indexer.handle(event("watcher.file_created", "src/main.php"));

    await writeProjectFile(projectRoot, "src/main.php", "<?php\nrequire_once __DIR__ . '/second.php';\nfunction newName() {}\n");
    assert.equal(await indexer.handle(event("watcher.file_modified", "src/main.php")), true);

    const main = database.all("SELECT file_id FROM files WHERE path = ?", ["src/main.php"])[0];
    const second = database.all("SELECT file_id FROM files WHERE path = ?", ["src/second.php"])[0];
    assert.deepEqual(database.all("SELECT name FROM symbols WHERE file_id = ?", [main.file_id]), [{ name: "newName" }]);
    assert.deepEqual(database.all("SELECT name FROM symbols WHERE file_id = ? AND name = ?", [main.file_id, "oldName"]), []);
    assert.deepEqual(database.all("SELECT name, related_file_id FROM imports_exports WHERE file_id = ?", [main.file_id]), [
      { name: join(projectRoot, "src/second.php"), related_file_id: second.file_id }
    ]);
    assert.deepEqual(database.all("SELECT target_file_id FROM dependency_edges WHERE source_file_id = ?", [main.file_id]), [
      { target_file_id: second.file_id }
    ]);
  });
});

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

test("RENAME updates only the path and preserves the PHP file identity and relations", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/auth.php", "<?php\nclass Auth {}\n");
    await writeProjectFile(projectRoot, "src/main.php", "<?php\nrequire_once __DIR__ . '/auth.php';\n");
    await indexer.handle(event("watcher.file_created", "src/auth.php"));
    await indexer.handle(event("watcher.file_created", "src/main.php"));

    const auth = database.all("SELECT file_id FROM files WHERE path = ?", ["src/auth.php"])[0];
    const main = database.all("SELECT file_id FROM files WHERE path = ?", ["src/main.php"])[0];
    await mkdir(join(projectRoot, "src/security"), { recursive: true });
    await rename(join(projectRoot, "src/auth.php"), join(projectRoot, "src/security/auth.php"));

    assert.equal(await indexer.handle(event("watcher.file_renamed", "src/security/auth.php", "src/auth.php")), true);

    assert.deepEqual(database.all("SELECT file_id, path FROM files WHERE file_id = ?", [auth.file_id]), [{ file_id: auth.file_id, path: "src/security/auth.php" }]);
    assert.deepEqual(database.all("SELECT name FROM symbols WHERE file_id = ?", [auth.file_id]), [{ name: "Auth" }]);
    assert.deepEqual(database.all("SELECT related_file_id, is_broken FROM imports_exports WHERE file_id = ?", [main.file_id]), [
      { related_file_id: auth.file_id, is_broken: 0 }
    ]);
  });
});

test("RENAME preserves the TypeScript file identity and imports", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/auth.ts", "export class Auth {}\n");
    await writeProjectFile(projectRoot, "src/main.ts", "import { Auth } from './auth.ts';\nexport { Auth };\n");
    await indexer.handle(event("watcher.file_created", "src/auth.ts"));
    await indexer.handle(event("watcher.file_created", "src/main.ts"));

    const auth = database.all("SELECT file_id FROM files WHERE path = ?", ["src/auth.ts"])[0];
    const main = database.all("SELECT file_id FROM files WHERE path = ?", ["src/main.ts"])[0];
    await mkdir(join(projectRoot, "src/security"), { recursive: true });
    await rename(join(projectRoot, "src/auth.ts"), join(projectRoot, "src/security/auth.ts"));

    assert.equal(await indexer.handle(event("watcher.file_renamed", "src/security/auth.ts", "src/auth.ts")), true);

    assert.deepEqual(database.all("SELECT file_id, path FROM files WHERE file_id = ?", [auth.file_id]), [{ file_id: auth.file_id, path: "src/security/auth.ts" }]);
    assert.deepEqual(database.all("SELECT name FROM symbols WHERE file_id = ?", [auth.file_id]), [{ name: "Auth" }]);
    assert.deepEqual(database.all("SELECT related_file_id, is_broken FROM imports_exports WHERE file_id = ? AND kind = ?", [main.file_id, "named"]), [
      { related_file_id: auth.file_id, is_broken: 0 }
    ]);
  });
});

test("a parse failure logs a warning and retains the previous index", async () => {
  const warnings = [];
  await withIndexer({ logger: { warning(message, details) { warnings.push({ message, details }); } } }, async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "src/example.js", "export function valid() {}\n");
    await indexer.handle(event("watcher.file_created", "src/example.js"));

    await writeProjectFile(projectRoot, "src/example.js", "function {\n");
    assert.equal(await indexer.handle(event("watcher.file_modified", "src/example.js")), false);

    assert.deepEqual(database.all("SELECT name FROM symbols"), [{ name: "valid" }]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].details.path, "src/example.js");
  });
});

function event(type, path, oldPath) {
  return { type, payload: oldPath ? { path, old_path: oldPath } : { path } };
}

async function writeProjectFile(projectRoot, path, content) {
  const filePath = join(projectRoot, path);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function withIndexer(options, callback) {
  if (typeof options === "function") return withIndexer({}, options);

  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-incremental-indexer-"));
  const database = await openIndexDatabase(projectRoot);
  const indexer = createIncrementalIndexer({ database, projectRoot, ...options });
  try {
    await callback({ projectRoot, database, indexer });
  } finally {
    await database.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
}
