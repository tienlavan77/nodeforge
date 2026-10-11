// Verifies Coding plan progress stays project-scoped and does not regress or require a new network stream.
import assert from "node:assert/strict";
import test from "node:test";
import { applyCodingPlanLifecycle, createCodingPlanEvents } from "../lib/coding-plan-events.js";

// Supplies safe correlated lifecycle events without asserting approval authority.
function event(status, requestId = "REQUEST-A", projectId = "PROJECT-A") {
  return { project_id: projectId, event_type: `plan.request.${status}`, payload: { request_id: requestId, ...(status === "persisted" ? { plan_id: "PLAN-A", revision: 1, sha256: "a".repeat(64) } : {}), ...(status === "failed" ? { error_code: "PLAN_FAILED" } : {}) } };
}

test("shared fan-out delivers events for this project independent of conversation and unsubscribes", () => {
  const stream = createCodingPlanEvents("PROJECT-A");
  const seen = []; const other = [];
  const unsubscribe = stream.subscribe((input) => seen.push(input));
  stream.subscribe((input) => other.push(input));
  stream.publish(event("generating"));
  stream.publish({ ...event("persisted"), conversation_id: null });
  stream.publish(event("failed", "REQUEST-A", "PROJECT-B"));
  stream.publish({ ...event("failed"), project_id: undefined });
  assert.equal(seen.length, 2); assert.equal(other.length, 2);
  unsubscribe(); stream.publish(event("failed"));
  assert.equal(seen.length, 2); assert.equal(other.length, 3);
});

test("quick terminal transition retains observed generating, without granting artifact or approval authority", () => {
  let state = applyCodingPlanLifecycle({}, event("generating"), "PROJECT-A");
  state = applyCodingPlanLifecycle(state, event("persisted"), "PROJECT-A");
  assert.deepEqual(state["REQUEST-A"], { request_id: "REQUEST-A", status: "persisted", observed_generating: true });
  assert.equal(applyCodingPlanLifecycle(state, event("generating"), "PROJECT-A"), state);
  assert.equal(applyCodingPlanLifecycle(state, event("persisted"), "PROJECT-A"), state);
  assert.equal(applyCodingPlanLifecycle(state, event("failed"), "PROJECT-A"), state);
});

test("missed generating is not fabricated and other-project or malformed payload is ignored", () => {
  const state = applyCodingPlanLifecycle({}, event("failed"), "PROJECT-A");
  assert.equal(state["REQUEST-A"].observed_generating, false);
  assert.equal(applyCodingPlanLifecycle(state, event("generating", "REQUEST-B", "PROJECT-B"), "PROJECT-A"), state);
  assert.equal(applyCodingPlanLifecycle(state, { ...event("persisted"), payload: { request_id: "REQUEST-B", revision: 0 } }, "PROJECT-A"), state);
  assert.equal(applyCodingPlanLifecycle(state, event("generating", "bad/request"), "PROJECT-A"), state);
  assert.equal(applyCodingPlanLifecycle(state, { project_id: "PROJECT-A", event_type: "stream.connected" }, "PROJECT-A"), state);
});

test("progress history is bounded and cannot grow indefinitely in an idle Coding tab", () => {
  let state = {};
  for (let index = 0; index < 70; index++) state = applyCodingPlanLifecycle(state, event("persisted", `REQUEST-${index}`), "PROJECT-A");
  assert.equal(Object.keys(state).length, 50);
  assert.equal(state["REQUEST-0"], undefined);
  assert.equal(state["REQUEST-69"].status, "persisted");
});
