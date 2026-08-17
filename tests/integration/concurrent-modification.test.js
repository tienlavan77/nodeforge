import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentProcess } from "../../src/modules/agents/agent-process.js";
import { linkAgentSessions } from "../../src/modules/agents/agent-session-link.js";
import { createConcurrentModificationDetector } from "../../src/modules/agents/concurrent-modification-detector.js";
import { createSessionStore } from "../../src/modules/projects/session-store.js";

const fixture = fileURLToPath(new URL("../fixtures/agent-concurrent-write-fixture.js", import.meta.url));
const PROJECT_ID = "PROJECT-concurrent-modification-test";

test("emits one concurrent modification event when two Agent sessions report the same path", async () => {
  const result = await runScenario({
    writesA: [{ path: "src/shared.js", content: "export const writer = 'A';\n" }],
    writesB: [{ path: "src/shared.js", content: "export const writer = 'B';\n" }],
    afterWritesA: [{ path: "src/shared.js", content: "export const writer = 'A-again';\n" }]
  });

  assert.equal(result.writeAcks.length, 3);
  assert.deepEqual(result.conflicts.map(({ payload }) => payload), [{
    path: "src/shared.js",
    session_ids: ["SESSION-agent-A", "SESSION-agent-B"]
  }]);
});

test("does not warn when two Agent sessions report different paths", async () => {
  const result = await runScenario({
    writesA: [{ path: "src/agent-a.js", content: "export const writer = 'A';\n" }],
    writesB: [{ path: "src/agent-b.js", content: "export const writer = 'B';\n" }]
  });

  assert.equal(result.writeAcks.length, 2);
  assert.deepEqual(result.conflicts, []);
});

test("does not warn when one Agent session reports repeated touches for one path", async () => {
  const result = await runScenario({
    writesA: [
      { path: "src/repeated.js", content: "export const revision = 1;\n" },
      { path: "src/repeated.js", content: "export const revision = 2;\n" }
    ],
    writesB: []
  });

  assert.equal(result.writeAcks.length, 2);
  assert.deepEqual(result.conflicts, []);
});

async function runScenario({ writesA, writesB, afterWritesA = [], afterWritesB = [] }) {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-concurrent-modification-"));
  let database;
  let detector;
  let agentA;
  let agentB;
  let linkA;
  let linkB;

  try {
    database = await openIndexDatabase(projectRoot);
    const internalBus = new EventEmitter();
    const conflicts = [];
    const writeAcks = [];
    internalBus.on("event", (event) => {
      if (event.type === "agents.concurrent_modification_detected") conflicts.push(event);
    });
    const storeA = createSessionStore({ database, projectId: PROJECT_ID, createId: () => "SESSION-agent-A" });
    const storeB = createSessionStore({ database, projectId: PROJECT_ID, createId: () => "SESSION-agent-B" });
    agentA = createAgentProcess({ command: process.execPath, args: [fixture, "AGENT-A", PROJECT_ID, projectRoot] });
    agentB = createAgentProcess({ command: process.execPath, args: [fixture, "AGENT-B", PROJECT_ID, projectRoot] });
    linkA = linkAgentSessions({ agent: agentA, sessionStore: storeA });
    linkB = linkAgentSessions({ agent: agentB, sessionStore: storeB });
    agentA.on("message", (envelope) => collectWriteAck(envelope, writeAcks));
    agentB.on("message", (envelope) => collectWriteAck(envelope, writeAcks));
    const started = [once(linkA, "started"), once(linkB, "started")];
    const stopped = [once(linkA, "stopped"), once(linkB, "stopped")];
    detector = createConcurrentModificationDetector({
      database,
      internalBus,
      projectId: PROJECT_ID,
      participants: [
        { agent: agentA, sessionLink: linkA },
        { agent: agentB, sessionLink: linkB }
      ]
    });

    await Promise.all([sendAction(agentA, "start", "START-A"), sendAction(agentB, "start", "START-B")]);
    await Promise.all(started);
    await Promise.all([
      ...writesA.map((write, index) => sendAction(agentA, "write", `WRITE-A-${index}`, write)),
      ...writesB.map((write, index) => sendAction(agentB, "write", `WRITE-B-${index}`, write))
    ]);
    await waitFor(() => writeAcks.length === writesA.length + writesB.length);
    await Promise.all([
      ...afterWritesA.map((write, index) => sendAction(agentA, "write", `WRITE-A-AFTER-${index}`, write)),
      ...afterWritesB.map((write, index) => sendAction(agentB, "write", `WRITE-B-AFTER-${index}`, write))
    ]);
    await waitFor(() => writeAcks.length === writesA.length + writesB.length + afterWritesA.length + afterWritesB.length);

    const writtenPaths = [...new Set([...writesA, ...writesB, ...afterWritesA, ...afterWritesB].map(({ path }) => path))];
    for (const path of writtenPaths) {
      const content = await readFile(join(projectRoot, path), "utf8");
      assert.notEqual(content.length, 0);
    }
    const result = { conflicts: [...conflicts], writeAcks: [...writeAcks] };

    await Promise.all([sendAction(agentA, "stop", "STOP-A"), sendAction(agentB, "stop", "STOP-B")]);
    await Promise.all(stopped);
    assert.deepEqual(database.all("SELECT session_id, path FROM session_file_touches"), []);
    return result;
  } finally {
    detector?.close();
    linkA?.close();
    linkB?.close();
    for (const agent of [agentA, agentB]) {
      agent?.close();
      if (agent && !agent.child.killed && agent.child.exitCode === null) agent.child.kill();
    }
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
}

function collectWriteAck(envelope, writeAcks) {
  if (envelope.message?.type === "context.pack_generated" && envelope.message.payload?.action === "write_completed") {
    writeAcks.push(envelope);
  }
}

function sendAction(agent, action, suffix, details = {}) {
  return agent.send({
    protocol_version: "1.2.0",
    message_id: `MSG-${suffix}`,
    sender: { id: "NODE-001", type: "system", role: "orchestrator" },
    receiver: { id: "AGENT", type: "ai", role: "builder" },
    timestamp: "2026-08-17T18:10:00Z",
    message: {
      type: "context.request",
      request_id: `REQ-${suffix}`,
      project_id: PROJECT_ID,
      timestamp: "2026-08-17T18:10:00Z",
      payload: { action, ...details }
    }
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Agent fixture writes.");
}
