import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";
import { event, writeProjectFile, withIndexer } from "./incremental-indexer-test-support.js";

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

test("rolls back a multi-statement index write when a database operation fails", async () => {
  const calls = [];
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-index-rollback-"));
  await writeProjectFile(projectRoot, "src/new.js", "export function x() {}\n");
  const database = {
    transaction(operation) { calls.push("BEGIN"); try { const result = operation(); calls.push("COMMIT"); return result; } catch (error) { calls.push("ROLLBACK"); throw error; } },
    run() { throw new Error("simulated write failure"); },
    all() { return []; }
  };
  const indexer = createIncrementalIndexer({
    database,
    projectRoot,
    files: { findByPath: () => undefined, insert: () => "FILE-1" },
    graph: { replaceForFile() {} },
    registry: { extract: () => ({ symbols: [{ name: "x", kind: "function", start_line: 1, end_line: 1 }], imports: [], exports: [], calls: [] }) },
    getContentHash: async () => "hash",
    logger: { warning() {} }
  });
  await assert.rejects(() => indexer.handle({ type: "watcher.file_created", payload: { path: "src/new.js" } }), /simulated write failure/);
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK"]);
  await rm(projectRoot, { recursive: true, force: true });
});

test("indexer emits centralized start and completion log entries", async () => {
  const events = [];
  await withIndexer({ projectLogger: (entry) => events.push(entry) }, async ({ projectRoot, indexer }) => {
    await writeProjectFile(projectRoot, "src/logged.js", "export const logged = true;\n");
    await indexer.handle({ type: "watcher.file_created", task_id: "TASK-INDEX", ticket_id: "FORGE-LOG-001h", conversation_id: "CONV-BUILDER", payload: { path: "src/logged.js" } });
  });
  assert.deepEqual(events.map((entry) => entry.event_name), ["index.started", "index.completed"]);
  assert.ok(events.every((entry) => entry.ticket_id === "FORGE-LOG-001h" && entry.conversation_id === "CONV-BUILDER"));
});

test("indexer emits a centralized failure log entry", async () => {
  const events = [];
  await withIndexer({ registry: { extract() { throw new Error("parse exploded"); } }, projectLogger: (entry) => events.push(entry) }, async ({ projectRoot, indexer }) => {
    await writeProjectFile(projectRoot, "src/broken.js", "export const broken = ;\n");
    assert.equal(await indexer.handle({ type: "watcher.file_created", task_id: "TASK-INDEX", ticket_id: "FORGE-LOG-001h", conversation_id: "CONV-BUILDER", payload: { path: "src/broken.js" } }), false);
  });
  assert.equal(events.at(-1).event_name, "index.failed");
  assert.equal(events.at(-1).status, "failed");
});

test("CREATE indexes CSS selectors and custom properties as symbols", async () => {
  await withIndexer(async ({ projectRoot, database, indexer }) => {
    await writeProjectFile(projectRoot, "ui/globals.css", ":root {\n  --color-primary: #3b82f6;\n}\n\n.layout-header {\n  display: flex;\n}\n");

    assert.equal(await indexer.handle(event("watcher.file_created", "ui/globals.css")), true);

    assert.deepEqual(database.all("SELECT name, kind, start_line, end_line FROM symbols ORDER BY name"), [
      { name: "--color-primary", kind: "css_variable", start_line: 2, end_line: 2 },
      { name: "layout-header", kind: "css_class", start_line: 5, end_line: 7 }
    ]);
    assert.deepEqual(database.all("SELECT language FROM files WHERE path = 'ui/globals.css'"), [{ language: "css" }]);
  });
});
