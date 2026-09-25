import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { event, writeProjectFile, sha256, withIndexer } from "./incremental-indexer-test-support.js";

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

test("stores the SHA-256 of new and modified file content without changing file_id", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    const first = "export function beforeHash() {}\n";
    const second = "export function afterHash() {}\n";
    await writeProjectFile(projectRoot, "src/example.js", first);
    await indexer.handle(event("watcher.file_created", "src/example.js"));
    const created = database.all("SELECT file_id, sha256 FROM files WHERE path = ?", ["src/example.js"])[0];
    assert.equal(created.sha256, sha256(first));

    await writeProjectFile(projectRoot, "src/example.js", second);
    await indexer.handle(event("watcher.file_modified", "src/example.js"));
    const modified = database.all("SELECT file_id, sha256 FROM files WHERE path = ?", ["src/example.js"])[0];
    assert.equal(modified.file_id, created.file_id);
    assert.equal(modified.sha256, sha256(second));
  });
});

test("stores valid SHA-256 values for empty and binary files", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    const binary = Buffer.from([0, 255, 1, 2]);
    await writeProjectFile(projectRoot, "src/empty.txt", "");
    await writeProjectFile(projectRoot, "src/data.bin", binary);
    await indexer.handle(event("watcher.file_created", "src/empty.txt"));
    await indexer.handle(event("watcher.file_created", "src/data.bin"));

    assert.deepEqual(database.all("SELECT path, sha256 FROM files ORDER BY path"), [
      { path: "src/data.bin", sha256: sha256(binary) },
      { path: "src/empty.txt", sha256: sha256("") }
    ]);
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
