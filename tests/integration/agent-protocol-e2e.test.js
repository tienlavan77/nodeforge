import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBootstrap } from "../../src/bootstrap/index.js";
import { createFilesystemWatcher } from "../../src/infrastructure/filesystem/watcher.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentProcess } from "../../src/modules/agents/agent-process.js";
import { linkAgentSessions } from "../../src/modules/agents/agent-session-link.js";
import { createConcurrentModificationDetector } from "../../src/modules/agents/concurrent-modification-detector.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";
import { ProjectRegistry } from "../../src/modules/projects/project-registry.js";
import { createSessionStore } from "../../src/modules/projects/session-store.js";
import { createDebouncedWatcher } from "../../src/modules/watcher/debounced-watcher.js";

const agentFixture = fileURLToPath(new URL("../fixtures/agent-ndjson-fixture.js", import.meta.url));
const sampleProjectFixture = fileURLToPath(new URL("../fixtures/sample-project", import.meta.url));
const SOURCE_PATH = "src/agent-e2e.js";
const SOURCE = "export function agentCompletedWork() {\n  return 'complete';\n}\n";

test("runs Agent Protocol end to end through session persistence, watcher indexing, and internalBus", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-agent-protocol-e2e-"));
  let database;
  let bootstrap;
  let agent;
  let linkage;
  let detector;

  try {
    await cp(sampleProjectFixture, projectRoot, { recursive: true });
    const projectId = await new ProjectRegistry({ createId: () => "PROJECT-agent-protocol-e2e" }).getOrCreate(projectRoot);
    database = await openIndexDatabase(projectRoot);
    const sessionStore = createSessionStore({
      database,
      projectId,
      createId: () => "SESSION-agent-protocol-e2e",
      clock: () => new Date("2026-08-17T16:00:00Z")
    });
    const rawWatcher = createFilesystemWatcher({ root: projectRoot, chokidarOptions: { interval: 20, usePolling: true } });
    const ready = once(rawWatcher, "ready");
    const watcher = createDebouncedWatcher({ rawWatcher, projectId, root: projectRoot, debounceMs: 200, renameWindowMs: 500 });
    const internalBus = new EventEmitter();
    const agentStreams = [];
    const watcherEvents = [];
    const concurrentModifications = [];
    internalBus.on("agent.stream", (message) => agentStreams.push(message));
    internalBus.on("event", (event) => {
      if (event.type.startsWith("watcher.")) watcherEvents.push(event);
      if (event.type === "agents.concurrent_modification_detected") concurrentModifications.push(event);
    });

    agent = createAgentProcess({ command: process.execPath, args: [agentFixture, "--e2e", projectRoot] });
    linkage = linkAgentSessions({ agent, sessionStore });
    const sessionStarted = once(linkage, "started").then(([session]) => session);
    const sessionStopped = once(linkage, "stopped").then(([session]) => session);
    const childExit = once(agent.child, "exit");
    detector = createConcurrentModificationDetector({
      database,
      internalBus,
      projectId,
      participants: [{ agent, sessionLink: linkage }]
    });
    bootstrap = createBootstrap({
      configOptions: { cwd: projectRoot },
      watcher,
      indexer: createIncrementalIndexer({ database, projectRoot }),
      agentProcesses: [agent],
      internalBus,
      loggerOptions: { sink: { log() {} } }
    });
    await bootstrap.start();
    await ready;

    await agent.send(triggerEnvelope(projectId));
    const created = await sessionStarted;
    const closed = await sessionStopped;
    const [exitCode, signal] = await childExit;
    const pid = agent.child.pid;
    await waitFor(() => database.all("SELECT file_id FROM files WHERE path = ?", [SOURCE_PATH]).length === 1);

    assert.deepEqual(created.agents, ["AGENT-FIXTURE-001"]);
    assert.deepEqual(created.capability_scopes, { context: [{ resource: "broker", actions: ["request"] }] });
    assert.deepEqual(sessionStore.get(created.id), closed);
    assert.equal(closed.status, "completed");
    assert.equal(exitCode, 0);
    assert.equal(signal, null);

    const files = database.all("SELECT file_id, path, sha256 FROM files");
    assert.deepEqual(files.map(({ path }) => path).sort(), [SOURCE_PATH, "src/auth.js", "src/utils.js"]);
    const file = files.find(({ path }) => path === SOURCE_PATH);
    assert.ok(file);
    assert.match(file.file_id, /^FILE-/);
    assert.equal(file.sha256, sha256(SOURCE));
    assert.deepEqual(database.all("SELECT name FROM symbols WHERE file_id = ?", [file.file_id]), [{ name: "agentCompletedWork" }]);
    assert.deepEqual(watcherEvents.filter(({ payload }) => payload.path === SOURCE_PATH).map(({ type }) => type), ["watcher.file_created"]);
    assert.deepEqual(concurrentModifications, []);

    const stdout = agentStreams.filter(({ source }) => source === "agent.stdout");
    assert.deepEqual(stdout.map(({ message }) => message.message.type), ["sessions.start", "agents.report_touch", "context.pack_generated", "sessions.stop"]);
    assert.deepEqual(agentStreams.filter(({ source }) => source === "agent.stderr").map(({ text }) => text), ["agent e2e writing file in two phases\n"]);
    assert.equal(watcherEvents.every((event) => event.type.startsWith("watcher.")), true);
    await assertProcessGone(pid);
  } finally {
    detector?.close();
    linkage?.close();
    await bootstrap?.stop();
    agent?.close();
    if (agent && !agent.child.killed && agent.child.exitCode === null) agent.child.kill();
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("indexes only the completed revision after an Agent writes a file in two phases", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-agent-protocol-partial-write-"));
  let database;
  let bootstrap;
  let agent;

  try {
    const projectId = await new ProjectRegistry({ createId: () => "PROJECT-agent-partial-write" }).getOrCreate(projectRoot);
    database = await openIndexDatabase(projectRoot);
    const rawWatcher = createFilesystemWatcher({ root: projectRoot, chokidarOptions: { interval: 20, usePolling: true } });
    const ready = once(rawWatcher, "ready");
    const watcher = createDebouncedWatcher({ rawWatcher, projectId, root: projectRoot, debounceMs: 200, renameWindowMs: 500 });
    const internalBus = new EventEmitter();
    const watcherEvents = [];
    const logs = [];
    internalBus.on("event", (event) => watcherEvents.push(event));

    agent = createAgentProcess({ command: process.execPath, args: [agentFixture, "--e2e", projectRoot] });
    const childExit = once(agent.child, "exit");
    bootstrap = createBootstrap({
      configOptions: { cwd: projectRoot },
      watcher,
      indexer: createIncrementalIndexer({ database, projectRoot }),
      agentProcesses: [agent],
      internalBus,
      loggerOptions: { sink: { log(record) { logs.push(record); } } }
    });
    await bootstrap.start();
    await ready;

    await agent.send(triggerEnvelope(projectId));
    await childExit;
    await waitFor(() => database.all("SELECT file_id FROM files WHERE path = ?", [SOURCE_PATH]).length === 1);

    const [file] = database.all("SELECT file_id, sha256 FROM files WHERE path = ?", [SOURCE_PATH]);
    assert.equal(file.sha256, sha256(SOURCE));
    assert.deepEqual(database.all("SELECT name FROM symbols WHERE file_id = ?", [file.file_id]), [{ name: "agentCompletedWork" }]);
    assert.deepEqual(watcherEvents.filter(({ payload }) => payload.path === SOURCE_PATH).map(({ type }) => type), ["watcher.file_created"]);
    assert.deepEqual(
      logs
        .filter(({ message, path }) => message === "Indexed watcher event" && path === SOURCE_PATH)
        .map(({ severity, message, event_type, path }) => ({ severity, message, event_type, path })),
      [{ severity: "info", message: "Indexed watcher event", event_type: "watcher.file_created", path: SOURCE_PATH }]
    );
  } finally {
    await bootstrap?.stop();
    agent?.close();
    if (agent && !agent.child.killed && agent.child.exitCode === null) agent.child.kill();
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function triggerEnvelope(projectId) {
  return {
    protocol_version: "1.2.0",
    message_id: "MSG-NODE-E2E-TRIGGER-001",
    sender: { id: "NODE-001", type: "system", role: "orchestrator" },
    receiver: { id: "AGENT-FIXTURE-001", type: "ai", role: "builder" },
    timestamp: "2026-08-17T16:00:00Z",
    message: {
      type: "context.request",
      request_id: "REQ-NODE-E2E-TRIGGER-001",
      project_id: projectId,
      timestamp: "2026-08-17T16:00:00Z",
      payload: { purpose: "run end-to-end fixture" }
    }
  };
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the Agent Protocol pipeline to index the final file.");
}

async function assertProcessGone(pid) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Agent process ${pid} is still alive.`);
}
