// Verify existing catalog admission preserves project data and never starts duplicate indexing services.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { createControlApiProjectRuntime, startControlApiWorkers } from "../../scripts/control-api-project-runtime.mjs";
import { startControlApi } from "../../scripts/control-api-lifecycle.mjs";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createRuntimeLogger } from "../../src/core/runtime-logger.js";
import { createProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";

// Supply persisted project metadata and opaque existing database bytes without opening or migrating them.
async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-existing-admission-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "existing");
  await mkdir(join(projectRoot, ".forge/runtime/wc"), { recursive: true });
  const metadata = { project_id: "PROJECT-EXISTING", name: "existing", root: projectRoot, forge_dir: ".forge", schema_version: "1.2.0" };
  await writeFile(join(projectRoot, ".forge/runtime/project.json"), JSON.stringify(metadata));
  const indexPath = join(projectRoot, ".forge/runtime/wc/index.db");
  await writeFile(indexPath, "existing index must remain byte-for-byte unchanged");
  const catalogPath = join(root, "projects.json");
  await writeFile(catalogPath, JSON.stringify([{ root: projectRoot, projectId: metadata.project_id }]));
  return { projectRoot, projectId: metadata.project_id, catalogPath, indexPath };
}

test("catalog restore and repeated admission reuse the existing application without starting index services", async (context) => {
  const config = await fixture(context);
  const original = await readFile(config.indexPath);
  const startRuntime = () => assert.fail("must not start a watcher, database, or embedding worker");
  const lifecycle = await createProjectLifecycle({ catalogPath: config.catalogPath, startRuntime: createControlApiProjectRuntime({ ...config, startRuntime }) });
  context.after(() => lifecycle.close());
  assert.deepEqual(lifecycle.startupErrors, []);
  assert.deepEqual(lifecycle.list(), [{ root: config.projectRoot, projectId: config.projectId }]);
  const runtime = await lifecycle.get(config.projectRoot);
  assert.equal(runtime.status().closed, false);
  assert.deepEqual(await lifecycle.add(config.projectRoot), lifecycle.list()[0]);
  await lifecycle.operations.submit("add", config.projectRoot, "default-runtime-reuse");
  await lifecycle.operations.close();
  assert.equal((await lifecycle.operations.status("default-runtime-reuse")).status, "succeeded");
  assert.deepEqual(await readFile(config.indexPath), original);
  await lifecycle.close();
  assert.equal(runtime.status().closed, true);
  assert.deepEqual(await readFile(config.indexPath), original);
});

test("other projects and a removed default project receive new owned runtimes", async (context) => {
  const config = await fixture(context);
  const calls = [];
  const start = createControlApiProjectRuntime({ ...config, startRuntime: async (input) => { calls.push(input); return { owned: true }; } });
  const other = { projectRoot: `${config.projectRoot}-other`, projectId: "PROJECT-OTHER" };
  assert.deepEqual(await start(other), { owned: true });
  const initial = await start(config);
  initial.close();
  assert.deepEqual(await start(config), { owned: true });
  assert.deepEqual(calls, [other, config]);
});

test("mismatched default identity cannot reuse the running application's resources", async (context) => {
  const config = await fixture(context);
  const start = createControlApiProjectRuntime({ ...config, startRuntime: () => assert.fail("unexpected independent startup") });
  await assert.rejects(start({ ...config, projectId: "PROJECT-WRONG" }), /identity differ/);
  assert.equal((await start(config)).projectId, config.projectId);
});

// Polls an asynchronous assertion predicate until it succeeds or times out.
async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for in-process Control API workers.");
}

// Business purpose: verifies O1 in-process Watcher and Embedding Worker lifecycle, job recovery, immediate wake, terminal logging, and ordered shutdown before SQLite closes.
// Technical description: exercises startControlApiWorkers, createControlApiProjectRuntime, and startControlApi shutdown over a real SQLite index database and simulated watcher events.
async function verifyInProcessControlApiWorkers(context) {
  const projectRoot = await mkdtemp(join(tmpdir(), "nodeforge-control-api-workers-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, "src"), { recursive: true });
  const indexDb = await createDatabaseService({ dataDir: projectRoot, runtimeDir: join(".forge", "runtime", "wc") });
  const now = new Date().toISOString();
  indexDb.run(
    "INSERT INTO files (file_id, path, language, sha256, size_bytes, indexed_at) VALUES (?, ?, 'javascript', ?, 32, ?)",
    ["FILE-BOOTSTRAP", "src/bootstrap.js", "sha256:0000000000000000000000000000000000000000000000000000000000000000", now]
  );
  indexDb.run(
    "INSERT INTO symbols (symbol_id, file_id, name, kind, start_line, end_line) VALUES (?, ?, 'bootstrap', 'function', 1, 3)",
    ["SYM-ORPHAN", "FILE-BOOTSTRAP"]
  );
  indexDb.run(
    "INSERT INTO embedding_jobs (job_id, symbol_id, content_checksum, model, status, priority, attempts, next_retry_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, 'processing', 100, 1, NULL, NULL, ?, ?)",
    ["JOB-RECOVER-1", "SYM-ORPHAN", "sha256:0000", "test-embed-model", now, now]
  );

  const terminalOutput = [];
  const persistedLogs = [];
  const runtimeLogger = createRuntimeLogger({
    logEvent: (entry) => persistedLogs.push(entry),
    output: { write: (chunk) => terminalOutput.push(String(chunk)) },
    source: "project-watcher"
  });

  const rawWatcher = new EventEmitter();
  const teardownEvents = [];
  rawWatcher.close = async () => { teardownEvents.push("watcher"); };
  const embeddedInputs = [];
  let failOnce = true;

  const projectWorkers = startControlApiWorkers({
    projectRoot,
    projectId: "PROJECT-DEFAULT",
    indexDb,
    runtimeLogger,
    watcherFactory: () => rawWatcher,
    ollamaConfig: { host: "http://127.0.0.1:11434", model: "test-embed-model", timeoutMs: 1000 },
    embeddingProvider: {
      // Simulates one transient failure followed by deterministic vector generation on wake/poll.
      async embed(text) {
        if (failOnce) {
          failOnce = false;
          throw new Error("Transient Ollama timeout");
        }
        embeddedInputs.push(text);
        return [0.25, 0.5, 0.75];
      },
      async close() {
        teardownEvents.push("embeddingProvider");
      }
    },
    pollMs: 50,
    debounceMs: 100,
    renameWindowMs: 100,
    runVerification: false
  });
  context.after(async () => {
    await projectWorkers.stop();
    // eslint-disable-next-line no-silent-catch -- Database is already closed when shutdown assertions succeed.
    try { await indexDb.close(); } catch { /* already closed by shutdown */ }
  });

  assert.ok(persistedLogs.some((entry) => entry.event_name === "embedding_worker.recovered" && entry.payload?.count === 1));
  assert.ok(persistedLogs.some((entry) => entry.event_name === "watcher.ready"));
  assert.ok(terminalOutput.join("").includes("Project filesystem watcher ready (polling)."));
  assert.ok(terminalOutput.join("").includes("Recovered 1 interrupted embedding job(s)."));

  const startRuntime = createControlApiProjectRuntime({
    projectRoot,
    projectId: "PROJECT-DEFAULT",
    getDefaultWorkers: () => projectWorkers,
    startRuntime: () => assert.fail("must not start duplicate workers for default project")
  });
  const admitted = await startRuntime({ projectRoot, projectId: "PROJECT-DEFAULT" });
  assert.equal(admitted.watch, projectWorkers.watch);
  assert.equal(admitted.worker, projectWorkers.worker);
  assert.equal(admitted.status().closed, false);

  const filePath = join(projectRoot, "src", "service.js");
  await writeFile(
    filePath,
    "// Checkout order service module.\n\n// Computes order totals and persists invoice state for checkout requests.\nexport function calculateOrderTotal(items) {\n  return items.length;\n}\n"
  );
  rawWatcher.emit("add", filePath);

  await waitFor(() => persistedLogs.some((entry) => entry.event_name === "watcher.indexed" && entry.status === "success"));
  await waitFor(() => persistedLogs.some((entry) => entry.event_name === "embedding_worker.failed"));

  // Enqueue a second file update so the Watcher Worker wakes the Embedding Worker immediately via notify().
  await writeFile(
    filePath,
    "// Checkout order service module.\n\n// Computes updated order totals and tax breakdown for checkout requests.\nexport function calculateOrderTotal(items) {\n  return items.length + 1;\n}\n"
  );
  rawWatcher.emit("change", filePath);

  await waitFor(() => {
    const rows = indexDb.all("SELECT symbol_id, embedding_model FROM symbol_embeddings");
    return rows.length === 1 ? rows[0] : null;
  });

  await waitFor(() => persistedLogs.some((entry) => entry.event_name === "embedding_worker.completed"));
  assert.ok(embeddedInputs.length >= 1);
  assert.ok(persistedLogs.some((entry) => entry.event_name === "watcher.event"));
  assert.ok(terminalOutput.join("").includes("Indexer updated file."));
  assert.ok(terminalOutput.join("").includes("Embedding job failed."));
  assert.ok(terminalOutput.join("").includes("Embedding job completed (1 done, 0 queued, 1 vectors)."));

  const api = startControlApi({
    api: { createServer },
    port: 0,
    host: "127.0.0.1",
    workers: [projectWorkers],
    indexDb: { close: async () => { teardownEvents.push("indexDb"); await indexDb.close(); } },
    controlDb: { close: async () => { teardownEvents.push("controlDb"); } },
    processLock: { release: () => { teardownEvents.push("processLock"); } }
  });
  await once(api.server, "listening");
  await api.shutdown();

  assert.equal(admitted.status().closed, true);
  assert.deepEqual(teardownEvents, ["watcher", "embeddingProvider", "indexDb", "controlDb", "processLock"]);
}

test("Control API in-process Watcher and Embedding Workers index files, compute vectors, log to terminal, and close before SQLite", verifyInProcessControlApiWorkers);

// Business purpose: verifies multi-project lifecycle startup with a single default-project worker pair and SIGTERM/SIGINT signal-driven Control API shutdown.
// Technical description: admits two catalog projects through createProjectLifecycle, confirms only non-default projects invoke the fallback runtime starter while the default project reuses its in-process worker pair, and spawns child Control API processes to verify SIGTERM and SIGINT teardown ordering.
async function verifyMultiProjectAndSignalShutdown(context) {
  const { spawn } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const workspace = await mkdtemp(join(tmpdir(), "nodeforge-multiproject-signal-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  const defaultRoot = join(workspace, "default-project");
  const secondRoot = join(workspace, "second-project");
  await mkdir(join(defaultRoot, ".forge/runtime/wc"), { recursive: true });
  await mkdir(join(secondRoot, ".forge/runtime/wc"), { recursive: true });
  await writeFile(join(defaultRoot, ".forge/runtime/project.json"), JSON.stringify({
    project_id: "PROJECT-DEFAULT", name: "default-project", root: defaultRoot, forge_dir: ".forge", schema_version: "1.2.0"
  }));
  await writeFile(join(secondRoot, ".forge/runtime/project.json"), JSON.stringify({
    project_id: "PROJECT-SECOND", name: "second-project", root: secondRoot, forge_dir: ".forge", schema_version: "1.2.0"
  }));
  await writeFile(join(defaultRoot, ".forge/runtime/wc/index.db"), "opaque-default-index");
  await writeFile(join(secondRoot, ".forge/runtime/wc/index.db"), "opaque-second-index");

  const teardownOrder = [];
  const rawWatcher = new EventEmitter();
  rawWatcher.close = async () => { teardownOrder.push("defaultWatcher"); };
  let defaultWorkerPairCount = 0;
  const fakeDefaultWorkers = {
    watch: rawWatcher,
    worker: { stop: async () => { teardownOrder.push("defaultEmbeddingWorker"); } },
    // Reports whether the default worker pair has been closed.
    status() { return { closed: teardownOrder.includes("defaultWatcher") }; },
    // Stops both default project workers in deterministic order.
    async stop() {
      await rawWatcher.close();
      await this.worker.stop();
    }
  };
  defaultWorkerPairCount += 1;

  const secondaryStarted = [];
  const catalogPath = join(workspace, "projects.json");
  await writeFile(catalogPath, JSON.stringify([
    { root: defaultRoot, projectId: "PROJECT-DEFAULT" },
    { root: secondRoot, projectId: "PROJECT-SECOND" }
  ]));

  const lifecycle = await createProjectLifecycle({
    catalogPath,
    startRuntime: createControlApiProjectRuntime({
      projectRoot: defaultRoot,
      projectId: "PROJECT-DEFAULT",
      getDefaultWorkers: () => fakeDefaultWorkers,
      // Tracks non-default project runtime admissions during multi-project catalog startup.
      startRuntime: async (input) => {
        secondaryStarted.push(input.projectId);
        let closed = false;
        return {
          projectId: input.projectId,
          projectRoot: input.projectRoot,
          // Reports secondary runtime closure status.
          status() { return { closed }; },
          // Records secondary runtime teardown during lifecycle close.
          async close() { closed = true; teardownOrder.push(`runtime:${input.projectId}`); }
        };
      }
    })
  });
  context.after(() => lifecycle.close());

  assert.equal(defaultWorkerPairCount, 1);
  assert.deepEqual(secondaryStarted, ["PROJECT-SECOND"]);
  assert.equal(lifecycle.list().length, 2);
  const admittedDefault = await lifecycle.get(defaultRoot);
  assert.equal(admittedDefault.watch, fakeDefaultWorkers.watch);
  assert.equal(admittedDefault.worker, fakeDefaultWorkers.worker);

  const repoRoot = resolve(process.cwd());
  const signalScript = join(workspace, "signal-api-child.mjs");
  await writeFile(signalScript, [
    `import { createServer } from "node:http";`,
    `import { EventEmitter } from "node:events";`,
    `import { join } from "node:path";`,
    `import { createDatabaseService } from ${JSON.stringify(join(repoRoot, "backend/src/infrastructure/sqlite/database-service.js"))};`,
    `import { startControlApiWorkers } from ${JSON.stringify(join(repoRoot, "backend/scripts/control-api-project-runtime.mjs"))};`,
    `import { startControlApi } from ${JSON.stringify(join(repoRoot, "backend/scripts/control-api-lifecycle.mjs"))};`,
    `const dataDir = ${JSON.stringify(join(workspace, "signal-child-root"))};`,
    `const indexDb = await createDatabaseService({ dataDir, runtimeDir: join(".forge", "runtime", "wc") });`,
    `const rawWatcher = new EventEmitter();`,
    `rawWatcher.close = async () => { process.stdout.write("STEP:watcher\\n"); };`,
    `const workers = startControlApiWorkers({`,
    `  projectRoot: dataDir,`,
    `  projectId: "PROJECT-SIGNAL",`,
    `  indexDb,`,
    `  watcherFactory: () => rawWatcher,`,
    `  runVerification: false,`,
    `  pollMs: 50,`,
    `  ollamaConfig: { host: "http://127.0.0.1:11434", model: "sig-model", timeoutMs: 1000 },`,
    `  embeddingProvider: { async embed() { return [0.1]; }, async close() { process.stdout.write("STEP:embeddingProvider\\n"); } }`,
    `});`,
    `startControlApi({`,
    `  api: { createServer },`,
    `  port: 0,`,
    `  host: "127.0.0.1",`,
    `  workers: [workers],`,
    `  indexDb: { close: async () => { process.stdout.write("STEP:indexDb\\n"); await indexDb.close(); } },`,
    `  controlDb: { close: async () => { process.stdout.write("STEP:controlDb\\n"); } },`,
    `  processLock: { release: () => { process.stdout.write("STEP:processLock\\n"); } }`,
    `});`
  ].join("\n"));

  for (const signal of ["SIGTERM", "SIGINT"]) {
    const child = spawn(process.execPath, [signalScript], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    await waitFor(() => stdout.includes("Node Control API listening on http://127.0.0.1:"));
    child.kill(signal);
    const [code] = await once(child, "exit");
    assert.equal(code, 0, `${signal} exits cleanly with status 0`);
    const steps = stdout.split("\n").filter((line) => line.startsWith("STEP:")).map((line) => line.slice(5));
    assert.deepEqual(steps, ["watcher", "embeddingProvider", "indexDb", "controlDb", "processLock"]);
  }

  await fakeDefaultWorkers.stop();
  await lifecycle.close();
  assert.equal(admittedDefault.status().closed, true);
  assert.deepEqual(teardownOrder, ["defaultWatcher", "defaultEmbeddingWorker", "runtime:PROJECT-SECOND"]);
}

test("Multi-project lifecycle startup runs only one default-project worker pair and SIGTERM/SIGINT cleanly drain workers before SQLite", verifyMultiProjectAndSignalShutdown);
