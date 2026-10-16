// Verifies the approved foundation package with real concurrent project runtimes, not a mocked CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFilesystemWatcher } from "../../src/infrastructure/filesystem/watcher.js";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";
import { fixture, waitFor, fdCount, response } from "./multi-project-lifecycle-support.js";
import "./multi-project-lifecycle-failures.test.js";

// Proves two projects serve independently with stable identity, watcher indexing, vectors, and SSE.
test("foundation serves two isolated projects and cleans resources across restart", async () => {
  const context = await fixture();
  try {
    const rawWatchers = [];
    const manager = await context.open({
      // Captures real watcher handles to inject a recoverable filesystem error.
      startRuntime(input) {
        return startProjectRuntime({ ...input, embeddingProvider: { embed: async () => [1, 0, 0] },
          // Keeps the production filesystem pipeline while exposing its error event to the test.
          watcherFactory(options) {
            const raw = createFilesystemWatcher(options);
            rawWatchers.push(raw);
            return raw;
          }
        });
      }
    });
    const [first, duplicate, second] = await Promise.all([
      manager.add(context.roots[0]), manager.add(context.roots[0]), manager.add(context.roots[1])
    ]);
    assert.deepEqual(first, duplicate);
    assert.match(first.projectId, /^PROJECT-[0-9a-f-]{36}$/);
    assert.notEqual(first.projectId, second.projectId);
    assert.equal(manager.list().length, 2);
    assert.equal(rawWatchers.length, 2);
    const runtimes = await Promise.all(context.roots.map((root) => manager.get(root)));
    assert.notEqual(runtimes[0].bus, runtimes[1].bus);
    assert.notEqual(runtimes[0].worker, runtimes[1].worker);
    assert.notEqual(runtimes[0].database, runtimes[1].database);
    for (const runtime of runtimes) {
      assert.equal(runtime.database.all("SELECT COUNT(*) AS count FROM files")[0].count, 1);
      await waitFor(() => runtime.database.all("SELECT COUNT(*) AS count FROM symbol_embeddings")[0].count > 0);
    }
    assert.equal(runtimes[0].database.all("SELECT name FROM symbols")[0].name, "project0");
    assert.equal(runtimes[1].database.all("SELECT name FROM symbols")[0].name, "project1");
    const sinks = runtimes.map((runtime) => {
      const sink = response();
      runtime.connect({ requestedProjectId: runtime.projectId, response: sink });
      assert.match(sink.chunks.join(""), /event: stream.snapshot/);
      assert.match(sink.chunks.join(""), new RegExp(runtime.projectId));
      return sink;
    });
    const events = [];
    runtimes[0].bus.on("event", (event) => events.push(event));
    const added = join(context.roots[0], "added.js");
    await writeFile(added, "export function added() { return 7; }\n");
    await waitFor(() => runtimes[0].database.all("SELECT path FROM files WHERE path = ?", ["added.js"]).length);
    await rename(added, join(context.roots[0], "renamed.js"));
    await waitFor(() => events.some((event) => event.type === "watcher.file_renamed"));
    await waitFor(() => runtimes[0].database.all("SELECT path FROM files WHERE path = ?", ["renamed.js"]).length);
    await unlink(join(context.roots[0], "renamed.js"));
    await waitFor(() => events.some((event) => event.type === "watcher.file_deleted"));
    await waitFor(() => runtimes[0].database.all("SELECT COUNT(*) AS count FROM files")[0].count === 1);
    rawWatchers[0].emit("error", new Error("Injected recoverable watcher error"));
    await writeFile(join(context.roots[0], "sample.js"), "export function recovered() { return 9; }\n");
    await waitFor(() => runtimes[0].database.all("SELECT name FROM symbols WHERE name = 'recovered'").length);
    await waitFor(() => sinks[0].chunks.join("").includes("added.js"));
    assert.ok(!sinks[1].chunks.join("").includes("added.js"));
    assert.ok(context.logs.some((entry) => entry.message.includes("watcher event failed")));
    const alias = join(context.directory, "alias");
    await symlink(context.roots[0], alias);
    assert.deepEqual(await manager.add(alias), first);
    await manager.close();
    await manager.close();
    assert.ok(sinks.every((sink) => sink.writableEnded));
    assert.ok(runtimes.every((runtime) => runtime.bus.eventNames().length === 0));
    for (const runtime of runtimes) assert.throws(() => runtime.database.all("SELECT 1"));
    await assert.rejects(manager.add(context.roots[0]), /closed/);
    await writeFile(join(context.roots[1], "sample.js"), "export function offlineChange() { return 3; }\n");
    const restored = await context.open();
    assert.equal(restored.startupErrors.length, 0);
    assert.deepEqual(restored.list(), [first, second]);
    const secondRuntime = await restored.get(context.roots[1]);
    assert.equal(secondRuntime.database.all("SELECT name FROM symbols")[0].name, "offlineChange");
    assert.equal(await restored.remove(context.roots[0]), true);
    assert.equal(await restored.remove(context.roots[0]), false);
    assert.equal(restored.list().length, 1);
    assert.equal(await restored.remove(context.roots[1]), true);
    assert.deepEqual(JSON.parse(await readFile(context.catalogPath, "utf8")), []);
    assert.ok(context.providers.every((provider) => provider.closed));
  } finally { await context.cleanup(); }
});

// Measures descriptor stability after warm-up across repeated real watcher and database lifecycles.
test("foundation repeated add/remove does not leak project descriptors", { skip: process.platform !== "linux" }, async () => {
  const context = await fixture();
  try {
    const manager = await context.open();
    await manager.add(context.roots[0]);
    await manager.remove(context.roots[0]);
    const before = await fdCount();
    for (let iteration = 0; iteration < 4; iteration += 1) {
      await Promise.all(context.roots.map((root) => manager.add(root)));
      assert.equal(manager.list().length, 2);
      await Promise.all(context.roots.map((root) => manager.remove(root)));
      assert.equal(manager.list().length, 0);
    }
    await manager.close();
    assert.ok(context.providers.every((provider) => provider.closed));
    await waitFor(async () => (await fdCount()) <= before, "Project lifecycle leaked file descriptors.");
  } finally { await context.cleanup(); }
});
