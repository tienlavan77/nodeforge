import assert from "node:assert/strict";
import test from "node:test";

import { createEventReplayEngine } from "../../src/modules/recovery/event-replay-engine.js";

const events = [
  event("agent.started", { state: "RUNNING" }),
  event("agent.plan.created", { step_count: 2 }),
  event("agent.step.completed", { step_id: "STEP-1" }),
  event("agent.step.completed", { step_id: "STEP-2" }),
  event("agent.completed", { state: "COMPLETED" })
];

test("rebuilds task, session, and agent state from ordered events", () => {
  const result = createEventReplayEngine().replay(events);
  assert.deepEqual(result, {
    state: {
      tasks: { "TASK-100": { status: "completed", completed_steps: 2, plan_steps: 2 } },
      sessions: { "SESSION-100": { state: "COMPLETED" } },
      agents: { "AGENT-100": { status: "completed", completed_steps: 2 } }
    }
  });
});

test("replay is deterministic and preserves stream order semantics", () => {
  const engine = createEventReplayEngine();
  assert.deepEqual(engine.replay(events), engine.replay([...events]));
  const failed = engine.replay([...events.slice(0, 3), event("agent.failed", { failed_step: "STEP-2" })]);
  assert.equal(failed.state.tasks["TASK-100"].status, "failed");
  assert.equal(failed.state.tasks["TASK-100"].completed_steps, 1);
  assert.equal(failed.state.sessions["SESSION-100"].state, "FAILED");
});

function event(event_type, payload) {
  return {
    event_type,
    payload,
    metadata: { project_id: "PROJECT-100", task_id: "TASK-100", session_id: "SESSION-100", agent_id: "AGENT-100" }
  };
}
