// Verifies REST removal releases real project resources while preserving durable project data.
// Source and static managed files are compared byte for byte; both SQLite databases are reopened
// after disposal to prove their persisted records remain usable without stale runtime handles.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises, { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fixture, response, startLifecycleHttpServer, waitFor } from "./multi-project-lifecycle-support.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";

// Captures every file byte and directory path, including SQLite databases and empty directories.
async function snapshot(root, prefix = "") {
  const files = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files[path + "/"] = "directory";
      Object.assign(files, await snapshot(root, path));
    } else files[path] = (await readFile(join(root, path))).toString("base64");
  }
  return files;
}

test("DELETE preserves source and managed files and releases watcher, worker, SQLite and SSE", async (t) => {
  const f = await fixture();
  const lifecycle = await f.open();
  const server = await startLifecycleHttpServer(lifecycle);
  try {
    const root = f.roots[0];
    await mkdir(join(root, "empty-source"));
    await writeFile(join(root, "source.db"), "Source-owned database bytes.\n");
    const sourceBefore = await snapshot(root);
    const other = await lifecycle.rest.intake({ root: f.roots[1], name: "Other project" });
    const otherRuntime = await lifecycle.get(f.roots[1]);
    await waitFor(() => otherRuntime.status().progress.embedding.status !== "running");
    const created = await fetch(server.baseUrl + "/forge/v1/projects", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, name: "Preserved", author: "Owner" })
    });
    assert.equal(created.status, 201, await created.clone().text());
    const { project } = await created.json();
    const runtime = await lifecycle.get(root);
    await waitFor(() => runtime.status().progress.embedding.status !== "running");
    await writeFile(join(root, ".forge", "retained.txt"), "Keep all managed data.\n");
    runtime.database.run("CREATE TABLE rest_index_preservation (value TEXT)");
    runtime.database.run("INSERT INTO rest_index_preservation VALUES (?)", ["index preserved"]);
    runtime.controlDb.run("CREATE TABLE rest_preservation (value TEXT)");
    runtime.controlDb.run("INSERT INTO rest_preservation VALUES (?)", ["preserved"]);
    await mkdir(join(root, ".forge", "empty-managed"));
    // Consolidates WAL data and uses rollback journals so orderly close leaves identical database bytes.
    for (const database of [runtime.database, runtime.controlDb]) {
      database.all("PRAGMA wal_checkpoint(TRUNCATE)");
      database.all("PRAGMA journal_mode = DELETE");
    }
    const before = await snapshot(root);
    for (const [path, bytes] of Object.entries(sourceBefore)) assert.equal(before[path], bytes);
    const destructive = [];
    // Records prohibited filesystem mutations during removal, including attempts that would fail.
    for (const api of [fs, fsPromises]) {
      for (const name of ["rm", "rmdir", "unlink", "rename", "truncate", "rmSync", "rmdirSync", "unlinkSync", "renameSync", "truncateSync"]) {
        if (typeof api[name] !== "function") continue;
        const original = api[name];
        t.mock.method(api, name, function (...args) {
          if (args.slice(0, name.startsWith("rename") ? 2 : 1).some((path) =>
            String(path) === root || String(path).startsWith(root + "/"))) destructive.push({ name, path: String(args[0]) });
          return Reflect.apply(original, this, args);
        });
      }
    }
    syncBuiltinESMExports();
    const sink = response();
    runtime.connect({ requestedProjectId: project.project_id, response: sink });
    const result = await fetch(server.baseUrl + "/forge/v1/projects/" + project.project_id, { method: "DELETE" });
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await result.json()).removed, true);
    assert.equal(runtime.status().closed, true);
    assert.equal(f.providers[1].closed, true);
    assert.equal(f.providers[0].closed, undefined);
    assert.deepEqual(destructive, []);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(sink.writableEnded, true);
    assert.throws(() => runtime.database.all("SELECT 1"));
    assert.throws(() => runtime.controlDb.all("SELECT 1"));
    assert.equal(await lifecycle.get(root), undefined);
    assert.deepEqual(await snapshot(root), before);
    const remaining = JSON.parse(await readFile(f.catalogPath, "utf8"));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].projectId, other.project_id);
    assert.equal(otherRuntime.status().closed, false);
    assert.deepEqual(otherRuntime.database.all("SELECT 1 AS usable"), [{ usable: 1 }]);
    await writeFile(join(f.roots[1], "after-removal.js"), "export const isolation = true;\n");
    await waitFor(() => otherRuntime.database.all("SELECT path FROM files").some((file) => file.path.endsWith("after-removal.js")));
    const index = await openIndexDatabase(root, { runtimeDir: join(".forge", "runtime", "wc") });
    const control = await openIndexDatabase(root, { storageKind: "control" });
    try {
      assert.deepEqual(index.all("SELECT value FROM rest_index_preservation"), [{ value: "index preserved" }]);
      assert.deepEqual(control.all("SELECT value FROM rest_preservation"), [{ value: "preserved" }]);
    } finally {
      await index.close();
      await control.close();
    }
    const restored = await f.open();
    assert.equal(restored.directory().length, 1);
    assert.equal(restored.directory()[0].projectId, other.project_id);
    const second = await fetch(server.baseUrl + "/forge/v1/projects/" + project.project_id, { method: "DELETE" });
    assert.equal(second.status, 404);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await server.close();
    await f.cleanup();
  }
});
