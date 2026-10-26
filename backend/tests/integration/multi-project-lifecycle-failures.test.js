// Exercises startup rollback, unavailable Ollama isolation, and shutdown cancellation in real project runtimes.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getProjectId } from "../../src/modules/projects/project-registry.js";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";
import { createControlApiConfig, runLifecycleCli, startLifecycleHttpServer } from "./multi-project-lifecycle-support.js";

test("Control API lifecycle HTTP routes and thin CLI project add/remove/list operate end-to-end across two roots in one process", async () => {
  const ctx = await fixture();
  let server = null;
  let unconfiguredServer = null;
  try {
    assert.equal(createControlApiConfig({ rootDir: ctx.roots[0], env: {} }).projectCatalogPath, null);
    assert.equal(
      createControlApiConfig({ rootDir: ctx.roots[0], env: { NODEFORGE_PROJECT_CATALOG_PATH: "/tmp/nodeforge-global/projects.json" } }).projectCatalogPath,
      "/tmp/nodeforge-global/projects.json"
    );
    assert.throws(
      () => createControlApiConfig({ rootDir: ctx.roots[0], env: { NODEFORGE_PROJECT_CATALOG_PATH: "relative/catalog.json" } }),
      /NODEFORGE_PROJECT_CATALOG_PATH must be a normalized absolute path/
    );
    assert.throws(
      () => createControlApiConfig({ rootDir: ctx.roots[0], env: { NODEFORGE_PROJECT_CATALOG_PATH: `${ctx.roots[0]}/.forge/projects.json` } }),
      /outside any project \.forge directory/
    );

    unconfiguredServer = await startLifecycleHttpServer(null);
    const unavailableRes = await fetch(`${unconfiguredServer.baseUrl}/lifecycle/list`);
    assert.equal(unavailableRes.status, 503);
    const unavailableBody = await unavailableRes.json();
    assert.equal(unavailableBody.error.code, "lifecycle_unavailable");
    assert.equal(unavailableBody.error.retryable, true);

    const lifecycle = await ctx.open();
    server = await startLifecycleHttpServer(lifecycle);

    const relCli = await runLifecycleCli(["project", "add", "relative/path", "--server", server.baseUrl]);
    assert.equal(relCli.code, 1);
    assert.match(relCli.stderr, /absolute path/i);

    const addViaOverride = await runLifecycleCli(["project", "add", ctx.roots[0], "--server", server.baseUrl], {
      env: { NODEFORGE_CONTROL_API_URL: "http://127.0.0.1:1" }
    });
    assert.equal(addViaOverride.code, 0);
    assert.match(addViaOverride.json.project.project_id, /^PROJECT-[0-9a-f-]{36}$/);

    const addViaEnv = await runLifecycleCli(["project", "add", ctx.roots[1]], {
      env: { NODEFORGE_CONTROL_API_URL: server.baseUrl }
    });
    assert.equal(addViaEnv.code, 0);
    assert.match(addViaEnv.json.project.project_id, /^PROJECT-[0-9a-f-]{36}$/);
    assert.notEqual(addViaOverride.json.project.project_id, addViaEnv.json.project.project_id);

    const listBoth = await runLifecycleCli(["project", "list", "--server", server.baseUrl]);
    assert.equal(listBoth.code, 0);
    assert.equal(listBoth.json.projects.length, 2);
    assert.deepEqual(listBoth.json.startup_errors, []);

    const badRootRes = await fetch(`${server.baseUrl}/lifecycle/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: "relative/root" })
    });
    assert.equal(badRootRes.status, 400);
    assert.equal((await badRootRes.json()).error.code, "invalid_lifecycle_root");

    const extraFieldRes = await fetch(`${server.baseUrl}/lifecycle/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: ctx.roots[0], extra: true })
    });
    assert.equal(extraFieldRes.status, 400);
    assert.equal((await extraFieldRes.json()).error.code, "invalid_lifecycle_root");

    const removeA = await runLifecycleCli(["project", "remove", ctx.roots[0], "--server", server.baseUrl]);
    assert.equal(removeA.code, 0);
    assert.equal(removeA.json.removed, true);

    const removeAgain = await runLifecycleCli(["project", "remove", ctx.roots[0], "--server", server.baseUrl]);
    assert.equal(removeAgain.code, 0);
    assert.equal(removeAgain.json.removed, false);

    const listAfterRemove = await runLifecycleCli(["project", "list", "--server", server.baseUrl]);
    assert.equal(listAfterRemove.code, 0);
    assert.deepEqual(
      listAfterRemove.json.projects.map((entry) => entry.project_id),
      [addViaEnv.json.project.project_id]
    );
  } finally {
    if (server) await server.close();
    if (unconfiguredServer) await unconfiguredServer.close();
    await ctx.cleanup();
  }
});
import { createOllamaEmbeddingProvider } from "../../src/modules/index/ollama-embedding-provider.js";
import { fixture, waitFor, fdCount } from "./multi-project-lifecycle-support.js";

// Ensures watcher readiness failure releases its database/provider and leaves unrelated projects serving.
test("foundation rolls back partial startup and retries with the same project identity", async () => {
  const context = await fixture();
  let fail = true;
  let rawClosed = 0;
  let providerClosed = 0;
  try {
    const manager = await context.open({
      // Fails one real database-backed runtime after the raw watcher is allocated.
      startRuntime(input) {
        const broken = input.projectRoot === context.roots[1] && fail;
        return startProjectRuntime({ ...input,
          embeddingProvider: { embed: async () => [1, 0, 0], close: async () => { providerClosed += 1; } },
          ...(broken ? {
            // Emits a real watcher startup error before readiness to exercise resource rollback.
            watcherFactory() {
              const raw = new EventEmitter();
              raw.close = async () => { rawClosed += 1; };
              queueMicrotask(() => raw.emit("error", new Error("Startup watcher failure")));
              return raw;
            }
          } : {})
        });
      }
    });
    const first = await manager.add(context.roots[0]);
    const before = process.platform === "linux" ? await fdCount() : null;
    await assert.rejects(manager.add(context.roots[1]), /Startup watcher failure/);
    assert.equal(manager.list().length, 1);
    assert.ok(rawClosed > 0);
    assert.ok(providerClosed > 0);
    if (before !== null) await waitFor(async () => (await fdCount()) <= before);
    const identity = await getProjectId(context.roots[1]);
    fail = false;
    const second = await manager.add(context.roots[1]);
    assert.equal(second.projectId, identity);
    assert.equal(manager.list()[0].projectId, first.projectId);
    assert.equal(manager.list().length, 2);
  } finally { await context.cleanup(); }
});

// Checks catalog persistence failure cannot leave an unregistered runtime or database alive.
test("foundation rolls back runtime when global catalog admission fails", async () => {
  const context = await fixture();
  try {
    const manager = await context.open();
    await writeFile(dirname(context.catalogPath), "not a directory");
    await assert.rejects(manager.add(context.roots[0]));
    assert.deepEqual(manager.list(), []);
    assert.equal(context.providers.length, 0);
    await rm(dirname(context.catalogPath));
    await mkdir(dirname(context.catalogPath));
    await manager.add(context.roots[0]);
    assert.equal(manager.list().length, 1);
  } finally { await context.cleanup(); }
});

// Proves unavailable Ollama affects only its project's durable worker, not another serving runtime.
test("foundation isolates unavailable Ollama and cancels active requests at shutdown", async () => {
  const context = await fixture();
  let requestStarted = false;
  let requestAborted = false;
  try {
    const manager = await context.open({
      // Uses the production serial Ollama provider with a deterministic offline endpoint substitute.
      startRuntime(input) {
        const broken = input.projectRoot === context.roots[0];
        const provider = createOllamaEmbeddingProvider({
          // Returns an unavailable service for one project and vectors for the independent project.
          async fetchFn() {
            if (broken) throw new Error("Ollama unavailable for first project");
            return Response.json({ embeddings: [[1, 0, 0]] });
          }
        });
        return startProjectRuntime({ ...input, embeddingProvider: provider });
      }
    });
    await Promise.all(context.roots.map((root) => manager.add(root)));
    const first = await manager.get(context.roots[0]);
    const second = await manager.get(context.roots[1]);
    await waitFor(() => first.status().embeddingError !== null);
    await waitFor(() => second.database.all("SELECT COUNT(*) AS count FROM symbol_embeddings")[0].count > 0);
    assert.equal(manager.list().length, 2);
    assert.equal(second.status().embeddingError, null);
    assert.ok(context.logs.some((entry) => entry.detail?.projectId === first.projectId));
    await manager.remove(context.roots[0]);
    const provider = createOllamaEmbeddingProvider({
      // Holds an Ollama request until the runtime cancels it during removal.
      fetchFn(url, { signal }) {
        requestStarted = true;
        return new Promise((resolveRequest, rejectRequest) => {
          signal.addEventListener("abort", () => {
            requestAborted = true;
            rejectRequest(new Error("Project request cancelled"));
          }, { once: true });
        });
      }
    });
    const pending = await startProjectRuntime({ projectRoot: context.roots[0], projectId: first.projectId, logger: context.logger, embeddingProvider: provider });
    try {
      pending.database.run("UPDATE embedding_jobs SET status = 'pending', next_retry_at = NULL WHERE status = 'retry_wait'");
      await waitFor(() => requestStarted);
    } finally { await pending.close(); }
    assert.equal(requestAborted, true);
    assert.equal(pending.bus.eventNames().length, 0);
  } finally { await context.cleanup(); }
});

// Retains failed restore metadata while admitting unaffected projects in the same process.
test("foundation restart reports missing roots without stopping unrelated projects", async () => {
  const context = await fixture();
  try {
    const manager = await context.open();
    await Promise.all(context.roots.map((root) => manager.add(root)));
    await manager.close();
    await rm(context.roots[0], { recursive: true });
    const restored = await context.open();
    assert.equal(restored.startupErrors.length, 1);
    assert.equal(restored.list().length, 1);
    assert.equal(restored.list()[0].root, context.roots[1]);
    assert.equal(await restored.remove(context.roots[0]), true);
    assert.equal(await restored.remove(context.roots[0]), false);
  } finally { await context.cleanup(); }
});
