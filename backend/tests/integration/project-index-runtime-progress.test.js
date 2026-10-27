// Exercises real project runtime readiness, isolated embedding failures and durable progress.
// Event-emitter watchers avoid platform timing while SQLite, indexing, lifecycle membership and
// the embedding worker remain production components with deterministic local providers.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";
import { createProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";
import { createProjectOperationStore } from "../../src/modules/projects/project-operation-store.js";
import { createIndexProgress } from "../../src/modules/index/index-progress.js";
import { quiet } from "./project-index-fixture.js";

// Makes watcher readiness deterministic without replacing runtime indexing or resource ownership.
function watcherFactory() {
  const watcher = new EventEmitter();
  watcher.close = async () => {};
  setImmediate(() => watcher.emit("ready"));
  return watcher;
}

// Creates isolated project and global metadata roots and removes them after runtime cleanup.
async function roots(t) {
  const directory = await mkdtemp(join(tmpdir(), "index-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, "first"); const second = join(directory, "second");
  await mkdir(first); await mkdir(second);
  return { directory, first, second };
}

// A broken required parser cannot be masked by the prior committed index or workspace startup.
test("runtime rejects required parse errors and exposes failed stage progress", async (t) => {
  const f = await roots(t);
  await writeFile(join(f.first, "a.js"), "function broken(");
  const progress = createIndexProgress();
  await assert.rejects(startProjectRuntime({ projectRoot: f.first, projectId: "PROJECT-first", watcherFactory,
    embeddingProvider: { embed: async () => [1, 0] }, logger: quiet, progress }), /Required indexing work failed/);
  assert.equal(progress.snapshot().status, "failed");
  assert.equal(progress.snapshot().counters.failed, 1);
  assert.equal(progress.snapshot().counters.indexed, 0);
  assert.equal(progress.snapshot().failures[0].marker, "parse_failed");
});

// Embedding provider errors remain project-local and do not redefine index or watcher readiness.
test("embedding failure stays separate from successful index readiness across projects", async (t) => {
  const f = await roots(t);
  const source = "// Application business functions.\n\n// Loads an account for the workspace.\nexport function load() {}\n";
  await writeFile(join(f.first, "a.js"), source);
  await writeFile(join(f.second, "a.js"), source);
  const first = await startProjectRuntime({ projectRoot: f.first, projectId: "PROJECT-first", watcherFactory, logger: quiet,
    embeddingProvider: { embed: async () => { throw new Error("provider unavailable"); } } });
  t.after(() => first.close());
  const second = await startProjectRuntime({ projectRoot: f.second, projectId: "PROJECT-second", watcherFactory, logger: quiet,
    embeddingProvider: { embed: async () => [1, 0] } });
  t.after(() => second.close());
  for (let retries = 0; retries < 100 && !first.status().embeddingError; retries += 1) await delay(20);
  const failed = first.status(); const healthy = second.status();
  assert.match(String(failed.embeddingError), /provider unavailable/);
  assert.equal(failed.progress.embedding.status, "failed");
  assert.ok(failed.progress.embedding.pending + failed.progress.embedding.failed > 0);
  assert.equal(failed.progress.status, "succeeded");
  assert.equal(failed.progress.counters.indexed, 1);
  assert.equal(failed.progress.checkpoint.files, 1);
  assert.equal(failed.progress.checkpoint.functions, 1);
  assert.equal(failed.closed, false);
  assert.equal(healthy.embeddingError, null);
  assert.equal(healthy.progress.status, "succeeded");
  assert.equal(healthy.progress.counters.failed, 0);
});

// Create persists progress under the same operation attempt/revision fence as final settlement.
test("Create saves staged progress and stale attempts cannot publish it", async (t) => {
  const f = await roots(t);
  const store = await createProjectOperationStore({ directory: join(f.directory, "operations") });
  const snapshots = [];
  const lifecycle = await createProjectLifecycle({ catalogPath: join(f.directory, "global", "projects.json"), operationStore: store,
    logger: quiet, runtimeOptions: { watcherFactory, embeddingProvider: { embed: async () => [1, 0] }, onProgress: (value) => snapshots.push(value) } });
  t.after(() => lifecycle.close());
  const entry = await lifecycle.create(join(f.directory, "created"), { requestKey: "create-index-progress" });
  const saved = await store.loadByRequestKey("create-index-progress");
  assert.equal(saved.status, "succeeded");
  assert.equal(saved.progress.status, "succeeded");
  assert.equal(saved.progress.attempt, saved.attempt);
  assert.equal(saved.progress.checkpoint.files, 0);
  assert.equal(saved.project_id, entry.projectId);
  for (const state of Object.values(saved.progress.stages)) assert.equal(state, "completed");
  await assert.rejects(store.transition(saved.operation_id, saved.revision, { progress: saved.progress }, { attempt: saved.attempt }), /lease/);
});

// Watcher retries retain failure evidence while allowing corrected content to restore health.
test("watcher progress reports failed parsing and a later committed retry restores success", async (t) => {
  const f = await roots(t);
  await writeFile(join(f.first, "a.js"), "function before() {}");
  let rawWatcher;
  const runtime = await startProjectRuntime({ projectRoot: f.first, projectId: "PROJECT-first", logger: quiet,
    embeddingProvider: { embed: async () => [1, 0] },
    // Captures the actual watcher input while retaining its normal debounce and index pipeline.
    watcherFactory() { rawWatcher = watcherFactory(); return rawWatcher; }
  });
  t.after(() => runtime.close());
  // Awaits the post-commit bus result with a bounded failure timeout.
  async function change(content) {
    await writeFile(join(f.first, "a.js"), content);
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Missing watcher index result")), 5000);
      runtime.bus.once("index.result", (value) => { clearTimeout(timeout); resolve(value); });
    });
    rawWatcher.emit("change", join(f.first, "a.js"));
    return result;
  }
  const original = runtime.status().progress.checkpoint;
  assert.equal((await change("function invalid(")).status, "failed");
  const failed = runtime.status().progress;
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.checkpoint, original);
  assert.equal((await change("function after() {}")).status, "indexed");
  const repaired = runtime.status().progress;
  assert.equal(repaired.status, "succeeded");
  assert.equal(repaired.counters.indexed, 2);
  assert.equal(repaired.counters.failed, 1);
  assert.equal(repaired.failures[0].resolved, true);
  assert.equal(repaired.checkpoint.files, 1);
  assert.ok(repaired.checkpoint.version > original.version);
});

// Progress publication requires a current attempt token even before any terminal state exists.
test("operation progress cannot publish without authority or with another attempt identity", async (t) => {
  const f = await roots(t);
  const store = await createProjectOperationStore({ directory: join(f.directory, "operations") });
  const registration = await store.register({ requestKey: "progress-fence", kind: "add", root: f.first });
  const operation = await store.claimAttempt(registration.operation.operation_id);
  // Release before the fixture removes the directory containing the attempt lease.
  const progress = createIndexProgress({ attempt: operation.attempt }).snapshot();
  await assert.rejects(store.transition(operation.operation_id, operation.revision, { progress }), /attempt token/);
  await assert.rejects(store.transition(operation.operation_id, operation.revision, { progress: { ...progress, attempt: 99 } }, { attempt: operation.attempt }), /Invalid index progress/);
  const saved = await store.transition(operation.operation_id, operation.revision, { progress }, { attempt: operation.attempt });
  assert.equal(saved.revision, operation.revision + 1);
  await assert.rejects(store.transition(saved.operation_id, saved.revision, { progress }, { attempt: saved.attempt }), /revision must advance/);
  await store.releaseAttempt(operation.operation_id, operation.attempt);
  const retry = await store.claimAttempt(operation.operation_id);
  assert.equal(retry.attempt, operation.attempt + 1);
  assert.equal(retry.progress, undefined);
  await store.releaseAttempt(retry.operation_id, retry.attempt);
});
