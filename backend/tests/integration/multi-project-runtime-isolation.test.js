// Proves independent project pipelines preserve runtime data and delivery through failures and recovery.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";
import { createSessionStore } from "../../src/modules/projects/session-store.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { createProjectStream } from "../../src/transport/sse/project-stream.js";

// Waits for observable pipeline completion rather than relying on a fixed indexing delay.
async function waitFor(predicate) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.fail("Project pipeline did not reach the expected state.");
}

// Captures persistent index and embedding results to detect writes into an idle project.
function snapshot(runtime) {
  return {
    files: runtime.database.all("SELECT * FROM files ORDER BY path"),
    symbols: runtime.database.all("SELECT * FROM symbols ORDER BY symbol_id"),
    embeddings: runtime.database.all("SELECT * FROM symbol_embeddings ORDER BY symbol_id")
  };
}

// Checks actual persisted embeddings for the newly indexed project symbol.
function embedded(runtime, name) {
  return runtime.database.all("SELECT s.name FROM symbols s JOIN symbol_embeddings e ON e.symbol_id = s.symbol_id WHERE s.name = ?", [name]).length > 0;
}

// Records real project stream frames using the runtime's own bus and database.
function delivery(runtime) {
  const frames = [];
  const subscriptions = createSubscriptionRegistry();
  const stream = createProjectStream({ projectId: runtime.projectId, indexDb: runtime.database, subscriptions, eventBus: runtime.bus });
  const connection = stream.connect({ requestedProjectId: runtime.projectId, response: {
    // Collects executable SSE output for project history assertions.
    write(chunk) { frames.push(chunk); },
    // Supplies the writable-response teardown contract without opening a network socket.
    end() {}
  } });
  return { frames, stream, subscriptions, close: connection.close };
}

test("isolates concurrent watcher, index, embedding, session and stream activity across identical paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-runtime-isolation-"));
  const roots = [join(directory, "first"), join(directory, "second")];
  const rawWatchers = new Map();
  const logs = [];
  const runtimes = [];
  const deliveries = [];
  let failFirst = false;
  const providers = roots.map((root, index) => ({
    // Distinguishes vectors from each project's independent embedding provider.
    async embed() {
      if (index === 0 && failFirst) throw new Error("first-project embedding unavailable");
      return index === 0 ? [1, 0, 0] : [0, 1, 0];
    }
  }));
  // Drives real debounce/index pipelines with controlled filesystem notifications and errors.
  function watcherFactory({ root }) {
    const watcher = new EventEmitter();
    watcher.close = async () => {};
    rawWatchers.set(root, watcher);
    setImmediate(() => watcher.emit("ready"));
    return watcher;
  }
  // Restarts only the selected project while keeping the other runtime active.
  async function start(index) {
    return startProjectRuntime({ projectRoot: roots[index], projectId: `PROJECT-${index}`, embeddingProvider: providers[index], watcherFactory,
      logger: {
        // Records affected-project watcher recovery and embedding failure diagnostics.
        error(message, detail) { logs.push({ message, detail }); },
        // Records retryable embedding failures for isolation assertions.
        warn(message, detail) { logs.push({ message, detail }); }
      }
    });
  }
  try {
    await Promise.all(roots.map(async (root, index) => {
      await mkdir(root);
      await writeFile(join(root, "sample.js"), `export function initial${index}() { return ${index}; }\n`);
    }));
    runtimes.push(...await Promise.all([start(0), start(1)]));
    const [runtimeA, runtimeB] = runtimes;
    assert.notEqual(runtimeA.bus, runtimeB.bus);
    assert.notEqual(runtimeA.worker, runtimeB.worker);
    assert.notEqual(runtimeA.database, runtimeB.database);
    await waitFor(() => embedded(runtimeA, "initial0") && embedded(runtimeB, "initial1"));
    assert.notDeepEqual(snapshot(runtimeA).embeddings, snapshot(runtimeB).embeddings);
    for (const [index, runtime] of runtimes.entries()) {
      assert.equal(runtime.database.databasePath, join(roots[index], ".forge/runtime/wc/index.db"));
      deliveries.push(delivery(runtime));
    }
    const sessions = roots.map((root, index) => createSessionStore({ projectId: `PROJECT-${index}`, fileService: createFileService({ projectRoot: root }) }));
    const records = await Promise.all(sessions.map((store) => store.ensureForTask({ task_id: "TASK-identical" })));
    assert.equal(records[0].id, records[1].id);
    assert.notEqual(records[0].project_id, records[1].project_id);
    const sessionPathB = join(roots[1], ".forge/runtime/nf/sessions/SESSION-TASK-identical.json");
    const sessionB = await readFile(sessionPathB, "utf8");
    await assert.rejects(sessions[0].ensureForTask({ task_id: "TASK-other", project_id: "PROJECT-1" }), { code: "PROJECT_CONTEXT_CONFLICT" });

    await Promise.all(roots.map(async (root, index) => {
      await writeFile(join(root, "sample.js"), `export function concurrent${index}() { return ${index + 2}; }\n`);
      rawWatchers.get(root).emit("change", join(root, "sample.js"));
    }));
    await waitFor(() => embedded(runtimeA, "concurrent0") && embedded(runtimeB, "concurrent1"));
    await waitFor(() => deliveries.every(({ frames }) => frames.some((frame) => frame.includes("watcher.file_indexed"))));
    assert.equal(snapshot(runtimeA).symbols.some(({ name }) => name === "concurrent1"), false);
    assert.equal(snapshot(runtimeB).symbols.some(({ name }) => name === "concurrent0"), false);
    const stableB = snapshot(runtimeB);
    const historyB = [...deliveries[1].frames];
    const errorsA = [];
    runtimeA.bus.on("watcher.error", (error) => errorsA.push(error));
    const indexedA = [];
    runtimeA.bus.on("watcher.indexed", (event) => indexedA.push(event));
    rawWatchers.get(roots[0]).emit("change", join(roots[1], "sample.js"));
    rawWatchers.get(roots[0]).emit("unlink", "../second/sample.js");
    await waitFor(() => errorsA.length === 2);
    assert.equal(indexedA.length, 0);
    assert.match(String(errorsA[0]?.message ?? JSON.stringify(errorsA[0])), /outside/i);

    rawWatchers.get(roots[0]).emit("error", new Error("recoverable first watcher failure"));
    failFirst = true;
    await writeFile(join(roots[0], "sample.js"), "export function failedEmbeddingA() { return 5; }\n");
    rawWatchers.get(roots[0]).emit("change", join(roots[0], "sample.js"));
    await waitFor(() => runtimeA.status().embeddingError === "first-project embedding unavailable");
    assert.equal(runtimeB.status().embeddingError, null);
    assert.equal(embedded(runtimeA, "failedEmbeddingA"), false);
    assert.deepEqual(snapshot(runtimeB), stableB);
    assert.deepEqual(deliveries[1].frames, historyB);
    assert.equal(await readFile(sessionPathB, "utf8"), sessionB);
    assert.deepEqual(await sessions[1].get(records[1].id), records[1]);
    assert.ok(logs.some(({ message }) => message === "Project watcher event failed."));

    deliveries[0].close();
    await runtimeA.close();
    failFirst = false;
    await writeFile(join(roots[0], "sample.js"), "export function recoveredA() { return 6; }\n");
    const recovered = await start(0);
    runtimes[0] = recovered;
    await waitFor(() => embedded(recovered, "recoveredA"));
    assert.notEqual(recovered.bus, runtimeB.bus);
    assert.deepEqual(snapshot(runtimeB), stableB);
    assert.deepEqual(deliveries[1].frames, historyB);
    assert.equal(await readFile(sessionPathB, "utf8"), sessionB);
    await writeFile(join(roots[1], "sample.js"), "export function stillRunningB() { return 7; }\n");
    rawWatchers.get(roots[1]).emit("change", join(roots[1], "sample.js"));
    await waitFor(() => embedded(runtimeB, "stillRunningB"));
  } finally {
    for (const stream of deliveries) stream.close();
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects foreign project events before stream delivery or wildcard history publication", () => {
  const runtime = { projectId: "PROJECT-A", bus: new EventEmitter(), database: { all: () => [] } };
  const output = delivery(runtime);
  const history = [];
  output.subscriptions.subscribe("*", (event) => history.push(event));
  try {
    const baseline = [...output.frames];
    runtime.bus.emit("watcher.indexed", { project_id: "PROJECT-B", payload: { path: "sample.js" } });
    runtime.bus.emit("agent.activity", { project_id: "PROJECT-B", payload: {} });
    runtime.bus.emit("agent.activity", { project_id: "PROJECT-A", metadata: { project_id: "PROJECT-B" }, payload: {} });
    assert.deepEqual(output.frames, baseline);
    for (const event of [
      { project_id: "PROJECT-B", type: "watcher.file_modified" },
      { project_id: "PROJECT-A", metadata: { project_id: "PROJECT-B" }, type: "watcher.file_modified" }
    ]) assert.throws(() => output.stream.ingest(event), { code: "PROJECT_CONTEXT_CONFLICT" });
    assert.deepEqual(history, []);
    assert.deepEqual(output.frames, baseline);
    output.stream.ingest({ project_id: "PROJECT-A", type: "watcher.file_modified", payload: { path: "sample.js" } });
    assert.equal(history.length, 1);
    assert.ok(output.frames.length > baseline.length);
  } finally {
    output.close();
  }
});
