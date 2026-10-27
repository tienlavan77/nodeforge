// Verifies REST removal releases real project resources while preserving durable project data.
// Source and static managed files are compared byte for byte; both SQLite databases are reopened
// after disposal to prove their persisted records remain usable without stale runtime handles.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, response, startLifecycleHttpServer, waitFor } from "./multi-project-lifecycle-support.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";

// Captures durable files recursively, excluding SQLite's transient journals and database pages.
async function snapshot(root, prefix = "") {
  const files = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(files, await snapshot(root, path));
    else if (!/\.db(?:-wal|-shm|-journal)?$/.test(entry.name)) files[path] = (await readFile(join(root, path))).toString("base64");
  }
  return files;
}

test("DELETE preserves source and managed files and releases watcher, worker, SQLite and SSE", async () => {
  const f = await fixture();
  const lifecycle = await f.open();
  const server = await startLifecycleHttpServer(lifecycle);
  try {
    const root = f.roots[0];
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
    const before = await snapshot(root);
    const sink = response();
    runtime.connect({ requestedProjectId: project.project_id, response: sink });
    const result = await fetch(server.baseUrl + "/forge/v1/projects/" + project.project_id, { method: "DELETE" });
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await result.json()).removed, true);
    assert.equal(runtime.status().closed, true);
    assert.equal(f.providers[0].closed, true);
    assert.equal(sink.writableEnded, true);
    assert.throws(() => runtime.database.all("SELECT 1"));
    assert.throws(() => runtime.controlDb.all("SELECT 1"));
    assert.equal(await lifecycle.get(root), undefined);
    assert.deepEqual(await snapshot(root), before);
    assert.deepEqual(JSON.parse(await readFile(f.catalogPath, "utf8")), []);
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
    assert.deepEqual(restored.directory(), []);
    const second = await fetch(server.baseUrl + "/forge/v1/projects/" + project.project_id, { method: "DELETE" });
    assert.equal(second.status, 404);
  } finally {
    await server.close();
    await f.cleanup();
  }
});
