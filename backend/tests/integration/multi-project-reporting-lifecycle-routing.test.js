/**
 * Business purpose: verifies end-to-end multi-project reporting, non-blocking background embedding readiness, unified progress contracts between default and secondary projects, strict per-project SSE/HTTP stream routing, and `/forge/v1/projects` UI client cutover.
 * Technical description: exercises `startControlApiWorkers`, `createControlApiProjectRuntime`, `startProjectRuntime`, `createProjectLifecycle`, `createProjectApplicationRegistry`, `createControlApiHttp`, `validateIndexProgress`, and UI project clients across concurrent projects.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readControlApiConfig } from "../../scripts/control-api-config.mjs";
import { createControlApiHttp } from "../../scripts/control-api-http.mjs";
import { createProjectApplicationRegistry } from "../../scripts/control-api-project-applications.mjs";
import { createControlApiProjectRuntime, startControlApiWorkers } from "../../scripts/control-api-project-runtime.mjs";
import { validateIndexProgress } from "../../src/modules/index/index-progress-contract.js";
import { createProjectLifecycle } from "../../src/modules/projects/project-lifecycle.js";
import { startProjectRuntime } from "../../src/modules/projects/project-runtime.js";
import { createRoutingApplication, createRoutingStorage } from "./multi-project-request-support.js";
import {
  addProject,
  getProjectSelection,
  preflightProject,
  refreshProjects,
  removeProject,
  selectProject,
  updateProject
} from "../../../ui/nextjs/lib/project-selection.js";
import { refreshProjectDirectory } from "../../../ui/nextjs/lib/project-directory-client.js";

/**
 * Business purpose: polls an asynchronous condition until it returns a truthy value so background worker and stream assertions settle deterministically.
 * Technical description: evaluates predicate every 15ms up to timeoutMs and throws an Error if the deadline expires.
 */
async function waitFor(predicate, label = "condition", timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * Business purpose: creates a controllable in-memory filesystem watcher for deterministic multi-project watcher isolation tests.
 * Technical description: returns an EventEmitter with close() that emits "ready" on the next microtask and records created watcher instances by root.
 */
function createWatcherRegistry() {
  const byRoot = new Map();
  // Instantiates and registers an EventEmitter watcher for a given project root.
  function watcherFactory({ root }) {
    const watcher = new EventEmitter();
    watcher.closed = false;
    watcher.close = async () => { watcher.closed = true; };
    byRoot.set(root, watcher);
    setImmediate(() => watcher.emit("ready"));
    return watcher;
  }
  return { byRoot, watcherFactory };
}

/**
 * Business purpose: opens an SSE endpoint and parses incoming event frames until closed or matched.
 * Technical description: performs a streaming fetch, decodes `data:` lines into JSON objects, and exposes `until()` and `close()` helpers.
 */
async function openSseStream(url) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let rawText = "";
  let buffer = "";
  let closed = false;
  // Reads chunks on demand until predicate matches or EOF is reached.
  async function readMatching(predicate) {
    while (!predicate()) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`SSE read timed out on ${url}`)), 5000).unref())
      ]);
      if (done) {
        closed = true;
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      rawText += chunk;
      buffer += chunk;
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
    }
  }
  return {
    events,
    get rawText() { return rawText; },
    get closed() { return closed; },
    // Waits until an SSE frame matching predicate arrives on this stream.
    async until(predicate) {
      await readMatching(() => Boolean(events.find(predicate)));
      const found = events.find(predicate);
      assert.ok(found, `Expected SSE event on ${url}`);
      return found;
    },
    // Waits until the raw SSE text contains a substring marker.
    async untilText(marker) {
      await readMatching(() => rawText.includes(marker));
      assert.ok(rawText.includes(marker), `Expected SSE text ${marker} on ${url}`);
      return rawText;
    },
    // Waits until the server closes the SSE stream (EOF).
    async untilClosed() {
      await readMatching(() => closed);
      assert.equal(closed, true, `Expected SSE stream ${url} to close`);
    },
    // Aborts the underlying fetch request immediately without waiting for server EOF.
    close() {
      closed = true;
      controller.abort();
    }
  };
}

test("O1, O2, O3, O5: concurrent projects isolate databases/queues/streams, unify progress contracts, and never block readiness on background embeddings", async (t) => {
  let step = "mkdtemp";
  const watchdog = setTimeout(() => {
    process.stderr.write(`WATCHDOG_STEP=${step}\n`);
    process.exit(1);
  }, 15000);
  watchdog.unref();
  const workspace = await mkdtemp(join(tmpdir(), "nf-mp-plan-5361dc3f-"));

  const rootA = join(workspace, "project-a");
  const rootB = join(workspace, "project-b");
  await mkdir(join(rootA, "src"), { recursive: true });
  await mkdir(join(rootB, "src"), { recursive: true });
  await writeFile(
    join(rootA, "src/alpha.js"),
    "// Alpha domain module for project A.\n\n// Computes alpha invoice totals for project A.\nexport function computeAlpha(v) {\n  return v + 1;\n}\n"
  );
  await writeFile(
    join(rootB, "src/beta.js"),
    "// Beta domain module for project B.\n\n// Computes beta settlement totals for project B.\nexport function computeBeta(v) {\n  return v * 2;\n}\n"
  );

  const watchers = createWatcherRegistry();
  let releaseEmbedA;
  const embedGateA = new Promise((resolve) => { releaseEmbedA = resolve; });
  let failEmbedA = true;
  let sharedProviderClosedCount = 0;
  const embeddedTexts = [];

  const sharedEmbeddingProvider = {
    model: "shared-test-model",
    // Simulates slow/failing embedding on project A while allowing project B to embed immediately.
    async embed(text) {
      embeddedTexts.push(text);
      if (text.includes("alpha")) {
        await embedGateA;
        if (failEmbedA) throw new Error("Project A transient embedding failure");
        return [1, 0, 0];
      }
      return [0, 1, 0];
    },
    // Tracks provider disposal to verify closing one project never disposes a shared provider in use.
    async close() {
      sharedProviderClosedCount += 1;
    }
  };

  const defaultProjectId = "project-a";
  const configA = readControlApiConfig({ cwd: rootA, env: { ...process.env, NODE_CONTROL_DATA_DIR: undefined, NODE_CONTROL_PROJECT_ID: defaultProjectId } });
  const defaultStorage = await createRoutingStorage({ config: configA });
  const defaultApp = await createRoutingApplication({ config: configA, storage: defaultStorage });
  const indexDbA = defaultStorage.indexDb;
  const now = new Date().toISOString();
  indexDbA.run(
    "INSERT INTO files (file_id, path, language, sha256, size_bytes, indexed_at) VALUES ('FILE-A1', 'src/alpha.js', 'javascript', 'sha256:a1', 64, ?)",
    [now]
  );
  indexDbA.run(
    "INSERT INTO symbols (symbol_id, file_id, name, kind, start_line, end_line, summary) VALUES ('SYM-A1', 'FILE-A1', 'computeAlpha', 'function', 3, 5, 'Computes alpha invoice totals for project A.')"
  );
  const defaultWorkers = startControlApiWorkers({
    projectRoot: rootA,
    projectId: defaultProjectId,
    indexDb: indexDbA,
    subscriptions: defaultApp.services.subscriptions,
    bus: defaultApp.services.bus,
    internalBus: defaultApp.services.internalBus,
    watcherFactory: watchers.watcherFactory,
    embeddingProvider: sharedEmbeddingProvider,
    pollMs: 25,
    debounceMs: 100,
    renameWindowMs: 100,
    runVerification: false,
    runtimeLogger: { info() {}, error() {}, warn() {}, emit() {} }
  });

  const catalogPath = join(workspace, "global", "projects.json");
  const lifecycle = await createProjectLifecycle({
    catalogPath,
    logger: { error() {}, warn() {}, info() {} },
    startRuntime: createControlApiProjectRuntime({
      projectRoot: rootA,
      projectId: defaultProjectId,
      getDefaultWorkers: () => defaultWorkers,
      // Starts secondary project runtimes with the shared embedding provider and isolated watchers.
      startRuntime: (options) => startProjectRuntime({
        ...options,
        watcherFactory: watchers.watcherFactory,
        embeddingProvider: sharedEmbeddingProvider,
        embeddingPollMs: 25,
        normalizeComments: false
      })
    })
  });

  const applications = createProjectApplicationRegistry({
    projectLifecycle: lifecycle,
    defaultApplication: defaultApp,
    defaultRoot: rootA,
    createStorage: createRoutingStorage,
    createApplication: createRoutingApplication
  });
  const http = createControlApiHttp({
    services: { ...defaultApp.services, projectLifecycle: lifecycle },
    resolveProjectServices: applications.resolve
  });
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const openStreams = [];

  t.after(async () => {
    step = "cleanup";
    releaseEmbedA?.();
    for (const s of openStreams) s.close();
    await defaultWorkers.stop();
    await lifecycle.close();
    await applications.close();
    try {
      await defaultStorage.disposal.close();
      // eslint-disable-next-line no-silent-catch -- Default storage may already be closed by applications.close().
    } catch { /* already closed */ }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
    clearTimeout(watchdog);
  });

  // Admit default Project A and secondary Project B while Project A's embedding is still blocked on embedGateA.
  step = "intake-A";
  const entryA = await lifecycle.rest.intake({ name: "Project A", root: rootA });
  assert.equal(entryA.projectId, defaultProjectId);
  step = "intake-B";
  const entryB = await lifecycle.rest.intake({ name: "Project B", root: rootB });
  const projectBId = entryB.projectId;
  assert.ok(projectBId && projectBId !== defaultProjectId);

  step = "status-check";
  const runtimeA = await lifecycle.get(rootA);
  const runtimeB = await lifecycle.get(rootB);
  assert.ok(runtimeA, "Default Project A is ready despite blocked background embedding");
  assert.ok(runtimeB, "Secondary Project B activated without waiting for Project A embedding backfill");

  // O2: Both default and secondary runtimes expose identical top-level progress contracts and pass validateIndexProgress.
  const statusA = runtimeA.status();
  const statusB = runtimeB.status();
  assert.equal(statusA.readiness, "ready");
  assert.equal(statusB.readiness, "ready");
  validateIndexProgress(statusA.progress);
  validateIndexProgress(statusB.progress);
  assert.equal(statusA.progress.embedding.status, "running");

  step = "wait-embed-B";
  await waitFor(() => runtimeB.status().progress.embedding.succeeded === 1, "Project B embedding completion");
  assert.equal(runtimeB.status().progress.embedding.status, "succeeded");

  step = "wait-embed-A-fail";
  // Release Project A embedding gate to trigger transient failure; verify readiness stays ready and error is scoped to Project A.
  releaseEmbedA();
  await waitFor(() => runtimeA.status().progress.embedding.status === "failed", "Project A embedding failure diagnostic");
  assert.equal(runtimeA.status().readiness, "ready");
  assert.equal(runtimeA.status().progress.embedding.projectId, defaultProjectId);
  assert.match(String(runtimeA.status().embeddingError), /Project A transient embedding failure/);
  assert.equal(runtimeB.status().embeddingError, null);
  assert.equal(runtimeB.status().progress.embedding.status, "succeeded");

  step = "open-project-streams";
  // O3: Verify default Project A and secondary Project B streams route both project and conversation events without cross-talk.
  const projectStreamA = await openSseStream(`${baseUrl}/forge/v1/stream?project=${encodeURIComponent(defaultProjectId)}`);
  const projectStreamB = await openSseStream(`${baseUrl}/forge/v1/stream?project=${encodeURIComponent(projectBId)}`);
  openStreams.push(projectStreamA, projectStreamB);
  step = "wait-project-snapshots";
  const snapEventA = await projectStreamA.until((e) => e.event_type === "stream.snapshot");
  const snapEventB = await projectStreamB.until((e) => e.event_type === "stream.snapshot");
  assert.equal(snapEventA.project_id, defaultProjectId);
  assert.equal(snapEventA.payload.runtime?.readiness, "ready");
  assert.equal(snapEventB.project_id, projectBId);
  assert.equal(snapEventB.payload.runtime?.readiness, "ready");

  step = "open-conv-streams";
  const convStreamA = await openSseStream(`${baseUrl}/projects/${encodeURIComponent(defaultProjectId)}/conversations/CONV-1/stream`);
  const convStreamB = await openSseStream(`${baseUrl}/projects/${encodeURIComponent(projectBId)}/conversations/CONV-1/stream`);
  openStreams.push(convStreamA, convStreamB);

  step = "send-bus-messages";
  const servicesA = await applications.resolve(defaultProjectId);
  const servicesB = await applications.resolve(projectBId);
  servicesA.bus.send({
    id: "MSG-ONLY-A",
    project_id: defaultProjectId,
    conversation_id: "CONV-1",
    sender: { id: "OWNER", role: "project_owner" },
    recipient: { id: "ARCH", role: "architecture_manager" },
    message_type: "owner.message",
    payload: { text: "Hello only A" },
    timestamp: new Date().toISOString()
  });
  servicesB.bus.send({
    id: "MSG-ONLY-B",
    project_id: projectBId,
    conversation_id: "CONV-1",
    sender: { id: "OWNER", role: "project_owner" },
    recipient: { id: "ARCH", role: "architecture_manager" },
    message_type: "owner.message",
    payload: { text: "Hello only B" },
    timestamp: new Date().toISOString()
  });

  step = "wait-conv-messages";
  await convStreamA.untilText("MSG-ONLY-A");
  await convStreamB.untilText("MSG-ONLY-B");
  step = "wait-project-conv-messages";
  await projectStreamA.until((e) => e.event_type === "conversation.message.owner" && JSON.stringify(e).includes("Hello only A"));
  await projectStreamB.until((e) => e.event_type === "conversation.message.owner" && JSON.stringify(e).includes("Hello only B"));

  assert.equal(convStreamA.rawText.includes("MSG-ONLY-B"), false);
  assert.equal(convStreamB.rawText.includes("MSG-ONLY-A"), false);
  assert.equal(projectStreamA.events.some((e) => e.project_id !== defaultProjectId || JSON.stringify(e).includes("Hello only B")), false);
  assert.equal(projectStreamB.events.some((e) => e.project_id !== projectBId || JSON.stringify(e).includes("Hello only A")), false);

  step = "delete-B";
  // O1 & O5: Removing Project B closes B's streams and releases B's resources without closing sharedEmbeddingProvider or affecting Project A.
  const deleteRes = await fetch(`${baseUrl}/forge/v1/projects/${encodeURIComponent(projectBId)}`, { method: "DELETE" });
  assert.equal(deleteRes.status, 200);
  step = "wait-B-streams-closed";
  await projectStreamB.untilClosed();
  await convStreamB.untilClosed();
  step = "recover-A";
  assert.equal(projectStreamA.closed, false, "Project A project stream remains open");
  assert.equal(convStreamA.closed, false, "Project A conversation stream remains open");
  assert.equal(sharedProviderClosedCount, 0, "Shared embedding provider is not disposed while Project A is still active");

  // Recover Project A's embedding job after Project B was removed to prove sharedEmbeddingProvider still works for A.
  failEmbedA = false;
  indexDbA.run("UPDATE embedding_jobs SET next_retry_at = '1970-01-01T00:00:00.000Z' WHERE status = 'retry_wait'");
  defaultWorkers.worker.notify();
  await waitFor(() => runtimeA.status().progress.embedding.status === "succeeded", "Project A embedding recovery");
  assert.equal(runtimeA.status().progress.embedding.succeeded, 1);
  assert.equal(runtimeA.status().embeddingError, null);

  await projectStreamA.close();
  await convStreamA.close();
});

test("O4: UI project selection and directory clients use /forge/v1/projects for list, preflight, add, update, and remove without calling /lifecycle/*", async (t) => {
  const recorded = [];
  let catalog = [{ project_id: "PROJECT-1", name: "One", root: "/srv/one", readiness: "ready" }];
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    recorded.push({ pathname: url.pathname, method, body });
    assert.equal(url.pathname.startsWith("/lifecycle"), false, `Unexpected legacy call to ${url.pathname}`);
    if (url.pathname === "/forge/v1/projects/preflight" && method === "POST") {
      return Response.json({ status: "new", root: body.root });
    }
    if (url.pathname === "/forge/v1/projects" && method === "GET") {
      return Response.json({ projects: catalog });
    }
    if (url.pathname === "/forge/v1/projects" && method === "POST") {
      const created = { project_id: "PROJECT-2", name: body.name ?? "Two", root: body.root, readiness: "ready" };
      catalog = [...catalog, created];
      return Response.json({ project: created }, { status: 201 });
    }
    if (url.pathname === "/forge/v1/projects/PROJECT-2" && method === "PUT") {
      catalog = catalog.map((p) => (p.project_id === "PROJECT-2" ? { ...p, ...body } : p));
      return Response.json({ project: catalog.find((p) => p.project_id === "PROJECT-2") });
    }
    if (url.pathname === "/forge/v1/projects/PROJECT-2" && method === "DELETE") {
      catalog = catalog.filter((p) => p.project_id !== "PROJECT-2");
      return Response.json({ project_id: "PROJECT-2", removed: true });
    }
    throw new Error(`Unhandled route ${method} ${url.pathname}`);
  });

  await refreshProjectDirectory();
  await refreshProjects({ selectInitial: false });
  const preflight = await preflightProject("/srv/two");
  assert.equal(preflight.status, "new");
  const added = await addProject({ root: "/srv/two", name: "Two" });
  assert.equal(added.project_id, "PROJECT-2");
  selectProject("PROJECT-2");
  assert.equal(getProjectSelection().projectId, "PROJECT-2");
  const updated = await updateProject("PROJECT-2", { name: "Two Renamed" });
  assert.equal(updated.name, "Two Renamed");
  await removeProject("PROJECT-2");
  assert.equal(getProjectSelection().projectId, null);

  assert.equal(recorded.some((call) => call.pathname.includes("/lifecycle/")), false);
  for (const relativePath of [
    "ui/nextjs/lib/project-selection.js",
    "ui/nextjs/lib/project-directory-client.js",
    "ui/nextjs/components/project-directory.jsx"
  ]) {
    const content = await readFile(join(process.cwd(), relativePath), "utf8");
    assert.doesNotMatch(content, /fetch\([^)]*\/lifecycle\/|requestJson\([^)]*\/lifecycle\/|lifecycleRequest\(/);
  }
});


