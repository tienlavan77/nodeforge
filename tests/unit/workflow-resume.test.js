import assert from "node:assert/strict";
import test from "node:test";

import { createEventReplayEngine } from "../../src/modules/recovery/event-replay-engine.js";
import { createWorkflowResume } from "../../src/modules/recovery/workflow-resume.js";

test("finds the next uncompleted step without rerunning completed steps", () => {
  const state = replay(["STEP-1", "STEP-2"]);
  const result = createWorkflowResume().resume({ session: { id: "SESSION-101", state: "RUNNING" }, state });
  assert.deepEqual(result, { sessionId: "SESSION-101", nextStep: "STEP-3", completedSteps: 2 });
});

test("does not resume completed or failed workflows", () => {
  const resume = createWorkflowResume();
  assert.deepEqual(resume.resume({ session: { id: "SESSION-101", state: "COMPLETED" }, state: replay([]) }), { sessionId: "SESSION-101", nextStep: null, completedSteps: 0 });
  const failed = replay([], "agent.failed");
  assert.deepEqual(resume.resume({ session: { id: "SESSION-101", state: "FAILED" }, state: failed }), { sessionId: "SESSION-101", nextStep: null, completedSteps: 0 });
});

function replay(completed, terminal) {
  const events = [event("agent.started", { state: "RUNNING" }), event("agent.plan.created", { step_count: 3, step_ids: ["STEP-1", "STEP-2", "STEP-3"] })];
  for (const stepId of completed) events.push(event("agent.step.completed", { step_id: stepId }));
  if (terminal) events.push(event(terminal, { failed_step: "STEP-3" }));
  return createEventReplayEngine().replay(events).state;
}

function event(event_type, payload) {
  return { event_type, payload, metadata: { task_id: "TASK-101", session_id: "SESSION-101", agent_id: "AGENT-101" } };
}
