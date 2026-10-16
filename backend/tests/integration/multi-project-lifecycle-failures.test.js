// Exercises startup rollback, unavailable Ollama isolation, and shutdown cancellation in real project runtimes.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getProjectId } from "../../src/modules/projects/project-registry.js";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";
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
    assert.equal(context.providers[0].closed, true);
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
            return Response.json({ embedding: [1, 0, 0] });
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
