import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentBootstrap } from "../../src/modules/agent/agent-bootstrap.js";
import { createBuilderAdapter } from "../../src/agents/builder-adapter.js";
import { createReviewerAdapter } from "../../src/agents/reviewer-adapter.js";
import { createAgentSession } from "../../src/modules/agent/session.js";
import { createAgentSessionStore } from "../../src/modules/agent/session-store.js";
import { createRuntimeRecovery } from "../../src/modules/recovery/runtime-recovery.js";
import { createEventReplayEngine } from "../../src/modules/recovery/event-replay-engine.js";
import { createPersistentEventStore } from "../../src/modules/events/persistent-event-store.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";

test("persists governance Agent sessions and recovers only RUNNING/PAUSED identities after restart", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-agent-session-"));
  let database = await openIndexDatabase(root);
  try {
    const store = createAgentSessionStore({ database });
    const runtime = { startTask: () => ({ state: "RUNNING" }) };
    const dependencies = { bus: createAgentCommunicationBus(), architectureManager: { createArchitecturePlan: () => ({}) }, sprintLeader: { generateTickets: () => [] }, runtime, builder: createBuilderAdapter({ id: "builder-133" }), reviewer: createReviewerAdapter({ id: "reviewer-133" }), sessionStore: store, recovery: createRuntimeRecovery({ sessionStore: store }), replayEngine: createEventReplayEngine(), eventStore: createPersistentEventStore({ database }) };
    const first = createAgentBootstrap(dependencies);
    const running = createAgentSession({ id: "SESSION-133-running" });
    running.start();
    first.persistSession("runtime", running, { workflow_id: "WORKFLOW-133", correlation_id: "CORR-133" });
    const paused = createAgentSession({ id: "SESSION-133-paused" });
    paused.start();
    paused.pause();
    first.persistSession("builder-133", paused, { workflow_id: "WORKFLOW-133", correlation_id: "CORR-133-B" });
    await database.close();

    database = await openIndexDatabase(root);
    const restartedStore = createAgentSessionStore({ database });
    const restarted = createAgentBootstrap({ ...dependencies, bus: createAgentCommunicationBus(), sessionStore: restartedStore, recovery: createRuntimeRecovery({ sessionStore: restartedStore }), eventStore: createPersistentEventStore({ database }) });
    assert.deepEqual(restarted.recoveredSessions.map(({ id, state, agent_id, workflow_id, correlation_id }) => ({ id, state, agent_id, workflow_id, correlation_id })), [
      { id: "SESSION-133-running", state: "RUNNING", agent_id: "runtime", workflow_id: "WORKFLOW-133", correlation_id: "CORR-133" },
      { id: "SESSION-133-paused", state: "PAUSED", agent_id: "builder-133", workflow_id: "WORKFLOW-133", correlation_id: "CORR-133-B" }
    ]);
    assert.equal(restarted.registry.list().length, 5);
    assert.equal(restartedStore.loadAll().length, 2);
    assert.equal(restarted.persistSession("runtime", running, { workflow_id: "WORKFLOW-133", correlation_id: "CORR-133" }).id, "SESSION-133-running");
    assert.equal(restartedStore.loadAll().length, 2);
  } finally {
    await database?.close();
    await rm(root, { recursive: true, force: true });
  }
});
