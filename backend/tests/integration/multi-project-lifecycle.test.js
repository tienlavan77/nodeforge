// Verifies the approved foundation package with real concurrent project runtimes, not a mocked CLI.
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { startControlApi } from "../../scripts/control-api-lifecycle.mjs";
import assert from "node:assert/strict";
import { readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFilesystemWatcher } from "../../src/infrastructure/filesystem/watcher.js";
import { startProjectWatch } from "../../src/modules/watcher/watch-project.js";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";
import { createOllamaEmbeddingProvider } from "../../src/modules/index/ollama-embedding-provider.js";
import { fixture, waitFor, fdCount, response } from "./multi-project-lifecycle-support.js";
import "./multi-project-lifecycle-failures.test.js";

// Keeps failed restart retries from replacing stable catalog identity while other projects serve.
test("retry preserves catalog identity until the per-root identity is repaired", async () => {
  const context = await fixture();
  try {
    const initial = await context.open();
    const first = await initial.add(context.roots[0]);
    const second = await initial.add(context.roots[1]);
    await initial.close();
    const catalogBefore = await readFile(context.catalogPath, "utf8");
    let repaired = false;
    const manager = await context.open({ registry: {
      // Models a changed per-root identity followed by an explicit identity repair.
      async getOrCreate(root) {
        if (root === first.root) return repaired ? first.projectId : "PROJECT-replaced";
        return second.projectId;
      }
    } });
    assert.equal(manager.startupErrors.length, 1);
    assert.deepEqual(manager.list(), [second]);
    const healthy = await manager.get(second.root);
    await assert.rejects(manager.add(first.root), /Catalog and per-root project identity differ/);
    assert.deepEqual(manager.list(), [second]);
    assert.equal(await manager.get(first.root), undefined);
    assert.equal(await readFile(context.catalogPath, "utf8"), catalogBefore);
    assert.equal(await manager.get(second.root), healthy);
    assert.equal(healthy.status().closed, false);
    repaired = true;
    assert.deepEqual(await manager.add(first.root), first);
    assert.equal(manager.list().length, 2);
  } finally { await context.cleanup(); }
});

// Proves two projects serve independently with stable identity, watcher indexing, vectors, and SSE.
test("foundation serves two isolated projects and cleans resources across restart", async () => {
  const context = await fixture();
  try {
    const rawWatchers = [];
    let failedRoot;
    await rename(join(context.roots[1], "sample.js"), join(context.roots[1], "second.js"));
    const manager = await context.open({
      // Captures real watcher handles to inject a recoverable filesystem error.
      startRuntime(input) {
        const embeddingProvider = createOllamaEmbeddingProvider({ model: "lifecycle-test",
          // Replaces only Ollama I/O so workers and query embeddings use the real provider contract.
          async fetchFn(url, request) {
            assert.ok(url.endsWith("/api/embeddings"));
            assert.equal(JSON.parse(request.body).model, "lifecycle-test");
            return { ok: input.projectRoot !== failedRoot, status: 503, json: async () => ({ embedding: [1, 0, 0] }) };
          }
        });
        return startProjectRuntime({ ...input, embeddingProvider, ollamaConfig: { model: "lifecycle-test" },
          // Keeps the production filesystem pipeline while exposing its error event to the test.
          watcherFactory(options) {
            const raw = createFilesystemWatcher(options);
            const errorHandlers = new Set();
            const facade = {
              // Preserves production watching and captures its registered error callbacks.
              on(type, handler) {
                if (type === "error") errorHandlers.add(handler);
                raw.on(type, handler);
                return this;
              },
              // Preserves readiness and startup-error subscriptions on the production watcher facade.
              once(type, handler) {
                if (type === "error") errorHandlers.add(handler);
                raw.once(type, handler);
                return this;
              },
              // Removes startup and pipeline error handlers exactly as production teardown does.
              off(type, handler) {
                if (type === "error") errorHandlers.delete(handler);
                raw.off(type, handler);
                return this;
              },
              // Closes the actual filesystem watcher owned by this runtime.
              close() { return raw.close(); },
              // Delivers an error through the same handlers used by the real filesystem watcher.
              fail(error) { for (const handler of [...errorHandlers]) handler(error); }
            };
            rawWatchers.push(facade);
            return facade;
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
      const queryVector = await runtime.embeddingProvider.embed("Find the project entry point");
      const hits = runtime.embeddingStore.search(queryVector, { model: "lifecycle-test" });
      assert.deepEqual(hits, [{ path: runtime === runtimes[0] ? "sample.js" : "second.js", score: 1 }]);
      assert.deepEqual(runtime.embeddingStore.search(queryVector, { model: "incompatible-model" }), []);
    }
    assert.deepEqual(runtimes.map((runtime) => runtime.database.all("SELECT name FROM symbols")[0].name), ["project0", "project1"]);
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
    rawWatchers[0].fail(new Error("Injected recoverable watcher error"));
    failedRoot = context.roots[0];
    await writeFile(join(context.roots[0], "sample.js"), "export function recovered() { return 9; }\n");
    await waitFor(() => runtimes[0].database.all("SELECT name FROM symbols WHERE name = 'recovered'").length);
    await waitFor(() => runtimes[0].status().embeddingError?.includes("503"));
    assert.deepEqual(runtimes[1].embeddingStore.search(await runtimes[1].embeddingProvider.embed("Find the project entry point"), { model: "lifecycle-test" }), [{ path: "second.js", score: 1 }]);
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
    await writeFile(join(context.roots[1], "second.js"), "export function offlineChange() { return 3; }\n");
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

// Exercises the actual Control API shutdown composition without defining management endpoints.
test("Control API shutdown awaits two project runtimes and releases legacy resources on failure", async () => {
  const context = await fixture();
  try {
    const manager = await context.open();
    await Promise.all(context.roots.map((root) => manager.add(root)));
    const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const released = [];
    const api = startControlApi({
      api: { createServer: () => createServer() }, port: 0, host: "127.0.0.1",
      projectLifecycle: manager,
      indexDb: { close: async () => released.push("index") },
      controlDb: { close: async () => released.push("control") },
      processLock: { release: () => released.push("lock") },
      ticketWorkspaceService: { close: async () => { throw new Error("Injected workspace cleanup failure"); } }
    });
    await once(api.server, "listening");
    const shutdown = api.shutdown();
    assert.equal(api.shutdown(), shutdown);
    await assert.rejects(shutdown, AggregateError);
    assert.deepEqual(manager.list(), []);
    assert.ok(context.providers.every((provider) => provider.closed));
    assert.deepEqual(released, ["index", "control", "lock"]);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], signals);
    assert.equal(api.server.listening, false);
  } finally { await context.cleanup(); }
});

// Upgrades an existing single-project index to semantic readiness without another command.
test("foundation supplies embeddings for an unchanged legacy watcher baseline", async () => {
  const context = await fixture();
  try {
    const watch = await startProjectWatch({ projectRoot: context.roots[0] });
    await watch.close();
    const manager = await context.open();
    await manager.add(context.roots[0]);
    const runtime = await manager.get(context.roots[0]);
    assert.equal(runtime.database.all("SELECT COUNT(*) AS count FROM files")[0].count, 1);
    await waitFor(() => runtime.database.all("SELECT COUNT(*) AS count FROM symbol_embeddings")[0].count > 0);
  } finally { await context.cleanup(); }
});

// Proves shutdown closes admissions already queued without leaking a newly started runtime.
test("foundation shutdown drains pending admission and preserves restart membership", async () => {
  const context = await fixture();
  try {
    const manager = await context.open();
    const admission = manager.add(context.roots[0]);
    const closing = manager.close();
    const admitted = await admission;
    await closing;
    assert.deepEqual(manager.list(), []);
    assert.ok(context.providers.every((provider) => provider.closed));
    const restored = await context.open();
    assert.deepEqual(restored.list(), [admitted]);
  } finally { await context.cleanup(); }
});
