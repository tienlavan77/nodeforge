import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { linkAgentSessions } from "../../src/modules/agents/agent-session-link.js";
import { createSessionStore } from "../../src/modules/projects/session-store.js";

test("rejects sessions.start without capability_scopes before creating a Session", async () => {
  const { agent, sessions, linkage } = createLinkage();
  try {
    const error = once(linkage, "protocol_error");
    agent.emit("message", startCommand({}));
    assert.match((await error).message, /Invalid capability_scopes declaration/);
    assert.deepEqual(sessions, []);
  } finally {
    linkage.close();
  }
});

test("rejects sessions.start with capability_scopes outside both Agent profiles before creating a Session", async () => {
  const { agent, sessions, linkage } = createLinkage();
  try {
    const error = once(linkage, "protocol_error");
    agent.emit("message", startCommand({ capability_scopes: { unknown: [] } }));
    assert.match((await error).message, /Invalid capability_scopes declaration/);
    assert.deepEqual(sessions, []);
  } finally {
    linkage.close();
  }
});

test("stores a Node capability profile unchanged without enforcing it", async () => {
  const { agent, sessions, linkage } = createLinkage();
  const capabilityScopes = {
    verification: [{ resource: "project", actions: ["run_test", "run_check"] }]
  };
  try {
    agent.emit("message", startCommand({ capability_scopes: capabilityScopes }));
    assert.deepEqual(sessions, [{
      taskId: undefined,
      agents: ["AGENT-capability-test"],
      capabilityScopes
    }]);
  } finally {
    linkage.close();
  }
});

test("persists and reads back a Node capability profile unchanged", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-node-capability-session-"));
  let database;
  let linkage;
  try {
    database = await openIndexDatabase(projectRoot);
    const agent = new EventEmitter();
    const capabilityScopes = {
      verification: [{ resource: "project", actions: ["run_test", "run_check"] }]
    };
    const sessionStore = createSessionStore({
      database,
      projectId: "PROJECT-node-capability-test",
      createId: () => "SESSION-node-capability-test",
      clock: () => new Date("2026-08-17T19:00:00Z")
    });
    linkage = linkAgentSessions({ agent, sessionStore });
    const started = once(linkage, "started");
    agent.emit("message", startCommand({ capability_scopes: capabilityScopes }));
    const session = await started;

    assert.deepEqual(sessionStore.get(session.id).capability_scopes, capabilityScopes);
  } finally {
    linkage?.close();
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function createLinkage() {
  const agent = new EventEmitter();
  const sessions = [];
  const linkage = linkAgentSessions({
    agent,
    sessionStore: {
      create(values) {
        sessions.push(values);
        return { id: "SESSION-should-not-exist" };
      },
      close() {}
    }
  });
  return { agent, sessions, linkage };
}

function startCommand(payload) {
  return {
    sender: { id: "AGENT-capability-test" },
    message: {
      type: "sessions.start",
      request_id: "REQ-capability-test",
      project_id: "PROJECT-capability-test",
      payload
    }
  };
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}
