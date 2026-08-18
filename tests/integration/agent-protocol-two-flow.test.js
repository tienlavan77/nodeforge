import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBootstrap } from "../../src/bootstrap/index.js";
import { createFilesystemWatcher } from "../../src/infrastructure/filesystem/watcher.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentProcess } from "../../src/modules/agents/agent-process.js";
import { createContextReadHandler } from "../../src/modules/agents/context-read-handler.js";
import { linkAgentSessions } from "../../src/modules/agents/agent-session-link.js";
import { createIncrementalIndexer } from "../../src/modules/index/incremental-indexer.js";
import { ProjectRegistry } from "../../src/modules/projects/project-registry.js";
import { createSessionStore } from "../../src/modules/projects/session-store.js";
import { createDebouncedWatcher } from "../../src/modules/watcher/debounced-watcher.js";

const execFile = promisify(execFileCallback);
const agentFixture = fileURLToPath(new URL("../fixtures/agent-ndjson-fixture.js", import.meta.url));
const sampleProjectFixture = fileURLToPath(new URL("../fixtures/sample-project", import.meta.url));
const AUTH_PATH = "src/auth.js";
const AUTH_SOURCE = "export function login(credentials) {\n  return credentials.token;\n}\n";

test("runs Builder and Reviewer agents end to end through Node context and the Code Index", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-agent-two-flow-"));
  let database;
  let bootstrap;
  let builder;
  let reviewer;
  let builderLink;
  let reviewerLink;
  let builderContext;
  let reviewerContext;

  try {
    await cp(sampleProjectFixture, projectRoot, { recursive: true });
    await writeFile(join(projectRoot, ".gitignore"), ".forge/runtime/\n");
    const projectId = await new ProjectRegistry({ createId: () => "PROJECT-two-flow" }).getOrCreate(projectRoot);
    await createGitBaseline(projectRoot);
    database = await openIndexDatabase(projectRoot);
    const sessionStore = createSessionStore({
      database,
      projectId,
      createId: (() => {
        let sequence = 0;
        return () => `SESSION-two-flow-${++sequence}`;
      })(),
      clock: () => new Date("2026-08-18T10:00:00Z")
    });
    const rawWatcher = createFilesystemWatcher({ root: projectRoot, chokidarOptions: { interval: 20, usePolling: true } });
    const watcherReady = once(rawWatcher, "ready");
    const watcher = createDebouncedWatcher({ rawWatcher, projectId, root: projectRoot, debounceMs: 200, renameWindowMs: 500 });
    const internalBus = new EventEmitter();
    const streams = [];
    const watcherEvents = [];
    internalBus.on("agent.stream", (message) => streams.push(message));
    internalBus.on("event", (event) => {
      if (event.type.startsWith("watcher.")) watcherEvents.push(event);
    });

    builder = createAgentProcess({ command: process.execPath, args: [agentFixture, "--builder-auth", projectRoot] });
    reviewer = createAgentProcess({ command: process.execPath, args: [agentFixture, "--reviewer-auth"] });
    builderLink = linkAgentSessions({ agent: builder, sessionStore });
    reviewerLink = linkAgentSessions({ agent: reviewer, sessionStore });
    builderContext = createContextReadHandler({ agent: builder, database, projectId, projectRoot });
    reviewerContext = createContextReadHandler({ agent: reviewer, database, projectId, projectRoot });
    const builderStarted = once(builderLink, "started").then(([session]) => session);
    const builderStopped = once(builderLink, "stopped").then(([session]) => session);
    const reviewerStarted = once(reviewerLink, "started").then(([session]) => session);
    const reviewerStopped = once(reviewerLink, "stopped").then(([session]) => session);
    const builderExit = once(builder.child, "exit");
    const reviewerExit = once(reviewer.child, "exit");
    bootstrap = createBootstrap({
      configOptions: { cwd: projectRoot },
      watcher,
      indexer: createIncrementalIndexer({ database, projectRoot }),
      agentProcesses: [builder, reviewer],
      internalBus,
      loggerOptions: { sink: { log() {} } }
    });
    await bootstrap.start();
    await watcherReady;

    await builder.send(triggerEnvelope(projectId, "AGENT-BUILDER-AUTH-001", "MSG-NODE-BUILDER-TRIGGER-001"));
    const builderSession = await withTimeout(builderStarted, "Builder session start");
    const builderClosed = await withTimeout(builderStopped, "Builder session stop");
    const [builderCode, builderSignal] = await withTimeout(builderExit, "Builder process exit");
    await withTimeout(waitFor(() => database.all("SELECT file_id FROM files WHERE path = ?", [AUTH_PATH]).length === 1), "Builder index update");

    const [authFile] = database.all("SELECT file_id, sha256 FROM files WHERE path = ?", [AUTH_PATH]);
    assert.equal(authFile.sha256, sha256(AUTH_SOURCE));
    assert.deepEqual(database.all("SELECT name FROM symbols WHERE file_id = ?", [authFile.file_id]), [{ name: "login" }]);
    assert.match(watcherEvents.find(({ payload }) => payload.path === AUTH_PATH)?.type ?? "", /^watcher\.file_(created|modified)$/);
    assert.deepEqual(builderSession.agents, ["AGENT-BUILDER-AUTH-001"]);
    assert.equal(builderClosed.status, "completed");
    assert.deepEqual(sessionStore.get(builderSession.id), builderClosed);
    assert.equal(builderCode, 0);
    assert.equal(builderSignal, null);

    await reviewer.send(triggerEnvelope(projectId, "AGENT-REVIEWER-AUTH-001", "MSG-NODE-REVIEWER-TRIGGER-001"));
    const reviewerSession = await withTimeout(reviewerStarted, "Reviewer session start");
    const reviewerClosed = await withTimeout(reviewerStopped, "Reviewer session stop");
    const [reviewerCode, reviewerSignal] = await withTimeout(reviewerExit, "Reviewer process exit");
    const verdict = await withTimeout(waitForValue(() => streams.find(({ source, agent_id, message }) => source === "agent.stdout" && agent_id === "AGENT-REVIEWER-AUTH-001" && message.message.type === "review.requested")), "Reviewer verdict");

    assert.notEqual(reviewerSession.id, builderSession.id);
    assert.deepEqual(reviewerSession.agents, ["AGENT-REVIEWER-AUTH-001"]);
    assert.equal(reviewerClosed.status, "completed");
    assert.deepEqual(sessionStore.get(reviewerSession.id), reviewerClosed);
    assert.deepEqual(verdict.message.message.payload, {
      result: "changes_required",
      findings: [{ path: AUTH_PATH, line: 2, severity: "warning", message: "Authentication result lacks error handling." }]
    });
    assert.equal(reviewerCode, 0);
    assert.equal(reviewerSignal, null);

    const builderTypes = streams
      .filter(({ source, agent_id }) => source === "agent.stdout" && agent_id === "AGENT-BUILDER-AUTH-001")
      .map(({ message }) => message.message.type);
    assert.deepEqual(builderTypes, ["sessions.start", "agents.report_touch", "context.pack_generated", "sessions.stop"]);
    assert.deepEqual(streams.filter(({ source, agent_id }) => source === "agent.stderr" && agent_id === "AGENT-BUILDER-AUTH-001").map(({ text }) => text), ["builder writing src/auth.js\n"]);
    assert.deepEqual(
      streams.filter(({ source, agent_id }) => source === "agent.stdout" && agent_id === "AGENT-REVIEWER-AUTH-001").map(({ message }) => message.message.type),
      ["sessions.start", "context.read_file", "review.requested", "sessions.stop"]
    );
    assert.equal(await gitStatus(projectRoot), " M src/auth.js");
    await assertProcessGone(builder.child.pid);
    await assertProcessGone(reviewer.child.pid);
  } finally {
    builderContext?.close();
    reviewerContext?.close();
    builderLink?.close();
    reviewerLink?.close();
    for (const agent of [builder, reviewer]) {
      agent?.close();
      if (agent && !agent.child.killed && agent.child.exitCode === null) agent.child.kill();
    }
    await bootstrap?.stop();
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function triggerEnvelope(projectId, agentId, messageId) {
  return {
    protocol_version: "1.2.0",
    message_id: messageId,
    sender: { id: "NODE-001", type: "system", role: "orchestrator" },
    receiver: { id: agentId, type: "ai", role: "worker" },
    timestamp: "2026-08-18T10:00:00Z",
    message: { type: "context.request", request_id: `REQ-${messageId}`, project_id: projectId, timestamp: "2026-08-18T10:00:00Z", payload: { purpose: "run fixture" } }
  };
}

async function createGitBaseline(projectRoot) {
  await execFile("git", ["init", "--quiet"], { cwd: projectRoot });
  await execFile("git", ["add", "."], { cwd: projectRoot });
  await execFile("git", ["-c", "user.name=Nodeforge Test", "-c", "user.email=nodeforge@example.test", "commit", "--quiet", "-m", "baseline"], { cwd: projectRoot });
}

async function gitStatus(projectRoot) {
  const { stdout } = await execFile("git", ["status", "--porcelain"], { cwd: projectRoot });
  return stdout.trimEnd();
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function waitFor(predicate, timeoutMs = 3000) {
  return waitForValue(() => predicate() ? true : undefined, timeoutMs);
}

async function waitForValue(getValue, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = getValue();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the Agent Protocol end-to-end condition.");
}

async function withTimeout(promise, label, timeoutMs = 4000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
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
