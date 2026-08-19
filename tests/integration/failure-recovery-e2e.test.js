import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentSession } from "../../src/modules/agent/session.js";
import { createAgentSessionStore } from "../../src/modules/agent/session-store.js";
import { createPersistentEventStore } from "../../src/modules/events/persistent-event-store.js";
import { createDeadLetterQueue } from "../../src/modules/recovery/dead-letter-queue.js";
import { createEventReplayEngine } from "../../src/modules/recovery/event-replay-engine.js";
import { createIdempotentRecovery } from "../../src/modules/recovery/idempotent-recovery.js";
import { createRetryPolicy } from "../../src/modules/recovery/retry-policy.js";
import { createRuntimeRecovery } from "../../src/modules/recovery/runtime-recovery.js";
import { createWorkflowResume } from "../../src/modules/recovery/workflow-resume.js";

test("recovers a persisted workflow without duplicate work and completes it", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-recovery-e2e-"));
  let database = await openIndexDatabase(projectRoot);
  try {
    const initialStore = createPersistentEventStore({ database });
    const initialSessions = createAgentSessionStore({ database });
    const session = createSession("SESSION-103-A");
    session.start();
    initialSessions.save(session);
    append(initialStore, "agent.started", { state: "RUNNING" });
    append(initialStore, "agent.plan.created", { step_count: 3, step_ids: ["STEP-1", "STEP-2", "STEP-3"] });
    append(initialStore, "agent.step.completed", { step_id: "STEP-1" });
    await database.close();

    database = await openIndexDatabase(projectRoot);
    const events = createPersistentEventStore({ database });
    const sessions = createAgentSessionStore({ database });
    const recovery = createRuntimeRecovery({ sessionStore: sessions });
    const recovered = recovery.recover().recoveredSessions;
    const replay = createEventReplayEngine().replay(events.getAll());
    const resume = createWorkflowResume().resume({ session: recovered[0], state: replay.state });
    const guard = createIdempotentRecovery();

    assert.deepEqual(recovered.map(({ id, state }) => ({ id, state })), [{ id: "SESSION-103-A", state: "RUNNING" }]);
    assert.equal(events.getAll().length, 3);
    assert.deepEqual(resume, { sessionId: "SESSION-103-A", nextStep: "STEP-2", completedSteps: 1 });
    assert.equal(guard.shouldExecute({ session: recovered[0], stepId: "STEP-1", state: replay.state }), false);
    assert.equal(guard.shouldExecute({ session: recovered[0], stepId: "STEP-2", state: replay.state }), true);

    let attempts = 0;
    await createRetryPolicy({ maxAttempts: 2 }).execute(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
    });
    assert.equal(attempts, 2);
    append(events, "agent.step.completed", { step_id: "STEP-2" });
    append(events, "agent.step.completed", { step_id: "STEP-3" });
    append(events, "agent.completed", { state: "COMPLETED", result: "completed" });
    const completed = createSession("SESSION-103-A");
    completed.start();
    completed.complete();
    sessions.save(completed);

    const finalReplay = createEventReplayEngine().replay(events.getAll());
    assert.equal(events.getAll().length, 6);
    assert.equal(finalReplay.state.tasks["TASK-103"].status, "completed");
    assert.equal(guard.shouldComplete({ session: sessions.load("SESSION-103-A"), state: finalReplay.state }), false);
    assert.equal(createRuntimeRecovery({ sessionStore: sessions }).recover().recoveredSessions.length, 0);
  } finally {
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("does not resume terminal or failed workflows and retains retry-exhausted work in DLQ", async () => {
  const resume = createWorkflowResume();
  const terminalState = {
    sessions: { "SESSION-103-terminal": { state: "COMPLETED", task_id: "TASK-103" } },
    tasks: { "TASK-103": { status: "completed", step_ids: ["STEP-1"], completed_step_ids: ["STEP-1"] } }
  };
  const failedState = {
    sessions: { "SESSION-103-failed": { state: "FAILED", task_id: "TASK-103" } },
    tasks: { "TASK-103": { status: "failed", step_ids: ["STEP-1"], completed_step_ids: [] } }
  };
  assert.equal(resume.resume({ session: { id: "SESSION-103-terminal", state: "COMPLETED" }, state: terminalState }).nextStep, null);
  assert.equal(resume.resume({ session: { id: "SESSION-103-failed", state: "FAILED" }, state: failedState }).nextStep, null);

  const dlq = createDeadLetterQueue({ createId: () => "DLQ-103", clock: () => new Date("2026-08-20T03:00:00Z") });
  const error = new Error("permanent failure");
  await assert.rejects(() => createRetryPolicy({ maxAttempts: 2 }).execute(() => { throw error; }), (actual) => actual === error);
  dlq.enqueue({ type: "agent.step", payload: { step_id: "STEP-1" } }, "max_attempts_exceeded");
  assert.deepEqual(dlq.getAll(), [{
    id: "DLQ-103", type: "agent.step", payload: { step_id: "STEP-1" }, reason: "max_attempts_exceeded", timestamp: "2026-08-20T03:00:00.000Z"
  }]);
});

function createSession(id) {
  return createAgentSession({ id, clock: () => new Date("2026-08-20T03:00:00Z") });
}

function append(store, type, payload) {
  const sequence = store.getAll().length + 1;
  return store.append({
    event_id: `EVT-103-${sequence}`,
    event_type: type,
    timestamp: "2026-08-20T03:00:00Z",
    source: "agent-runtime",
    payload,
    metadata: { project_id: "PROJECT-103", task_id: "TASK-103", session_id: "SESSION-103-A", agent_id: "AGENT-103" }
  });
}
