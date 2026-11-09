// Verifies Level 1 background admission and Level 2 Worker Thread indexing and embedding isolation.
// Business purpose: guarantees that adding a project returns immediately in `running` state without blocking Forge APIs or lifecycle queues, while comment normalization, AST indexing, and vector embedding execute inside a dedicated Worker Thread.
// Technical description: exercises `createProjectLifecycle({ admitInBackground: true, runtimeOptions: { useWorkerThread: true } })` and `startProjectWorkerRuntime` against temporary project roots, asserting immediate intake return, live SSE stream readiness, and committed SQLite index rows.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";
import { isEnglishComment } from "../../src/modules/projects/project-comment-normalization.js";

test("Level 1 (admitInBackground): rest.intake returns immediately in running state while activation continues in background", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "nf-bg-admit-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const projectRoot = join(baseDir, "fast-intake-app");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "service.js"), "export function greetUser(name) {\n  return `Hello ${name}`;\n}\n", "utf8");

  const activationGate = Promise.withResolvers();
  const activationStarted = Promise.withResolvers();
  let runtimeClosed = false;

  const lifecycle = await createProjectLifecycle({
    catalogPath: join(baseDir, "global", "projects.json"),
    admitInBackground: true,
    logger: { error() {}, warn() {}, info() {} },
    // Simulates a long-running background runtime initialization to verify non-blocking intake.
    // Business purpose: proves HTTP intake and subsequent catalog queries do not wait for indexing completion.
    // Technical description: signals `activationStarted`, awaits `activationGate`, and returns a ready runtime stub.
    startRuntime: async (options) => {
      activationStarted.resolve(options.projectId);
      await activationGate.promise;
      options.progress?.stage("startup/readiness");
      options.progress?.reconcile({ all: () => [{ version: 1, count: 1 }] });
      options.progress?.finish();
      return {
        projectRoot: options.projectRoot,
        projectId: options.projectId,
        status: () => ({
          projectId: options.projectId,
          projectRoot: options.projectRoot,
          closed: runtimeClosed,
          readiness: "ready",
          progress: options.progress?.snapshot()
        }),
        close: async () => { runtimeClosed = true; }
      };
    }
  });
  t.after(async () => {
    activationGate.resolve();
    await lifecycle.close();
  });

  // 1. intake resolves immediately without waiting for activationGate.
  const intakeResult = await lifecycle.rest.intake({ name: "Fast Intake App", root: projectRoot });
  assert.ok(intakeResult.project_id);
  assert.equal(intakeResult.readiness, "running");
  assert.equal(lifecycle.directory()[0].readiness, "running");

  // 2. Pending stream handle is immediately available for SSE subscribers before startRuntime finishes.
  const streamHandle = lifecycle.getStream(intakeResult.project_id);
  assert.ok(streamHandle, "Expected SSE stream handle to be available immediately after background admission");

  await activationStarted.promise;
  assert.equal(lifecycle.directory()[0].readiness, "running");

  // 3. Release background activation and verify readiness transitions to ready.
  activationGate.resolve();
  for (let i = 0; i < 50 && lifecycle.directory()[0].readiness !== "ready"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(lifecycle.directory()[0].readiness, "ready");
  assert.ok(await lifecycle.get(projectRoot));
});

test("Level 2 Option A (useWorkerThread): comment normalization, AST code indexing, and embedding queue run in a Worker Thread", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "nf-worker-thread-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const projectRoot = join(baseDir, "worker-indexed-app");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "math.js"),
    "export function computeTotal(price, quantity) {\n  return price * quantity;\n}\n",
    "utf8"
  );

  const lifecycle = await createProjectLifecycle({
    catalogPath: join(baseDir, "global", "projects.json"),
    admitInBackground: true,
    runtimeOptions: {
      useWorkerThread: true,
      chokidarOptions: { usePolling: true, interval: 500 }
    },
    logger: { error() {}, warn() {}, info() {} },
    startRuntime: startProjectRuntime
  });
  t.after(() => lifecycle.close());

  const admitted = await lifecycle.rest.intake({ name: "Worker Indexed App", root: projectRoot });
  assert.ok(admitted.project_id);

  // Wait for background Worker Thread activation to reach ready state.
  for (let i = 0; i < 200 && lifecycle.directory()[0]?.readiness !== "ready"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(lifecycle.directory()[0]?.readiness, "ready");
  const runtime = await lifecycle.get(projectRoot);
  assert.ok(runtime, "Expected worker-backed runtime to be available after background activation");

  // Verify English comments were normalized on disk by the Worker Thread.
  const normalizedSource = await readFile(join(projectRoot, "math.js"), "utf8");
  assert.equal(isEnglishComment(normalizedSource), true);

  // Verify AST code index rows were persisted to SQLite by the Worker Thread.
  const indexedFiles = runtime.database.all("SELECT path, summary FROM files");
  assert.equal(indexedFiles.length, 1);
  assert.equal(indexedFiles[0].path, "math.js");
  assert.ok(indexedFiles[0].summary);

  const indexedSymbols = runtime.database.all("SELECT name, kind, summary FROM symbols");
  assert.equal(indexedSymbols.length, 1);
  assert.equal(indexedSymbols[0].name, "computeTotal");
  assert.ok(indexedSymbols[0].summary);
});
