import assert from "node:assert/strict";
import test from "node:test";

import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";

test("isolates a failed subscriber and continues delivery", () => {
  const errors = [];
  const received = [];
  const subscriptions = createSubscriptionRegistry({ logger: { error: (_message, details) => errors.push(details) } });
  subscriptions.subscribe("agent.*", function failingHandler() { throw new Error("broken subscriber"); });
  subscriptions.subscribe("agent.*", (event) => received.push(event.event_id));

  assert.equal(subscriptions.publish({ event_type: "agent.completed", event_id: "EVT-003" }), 1);
  assert.deepEqual(received, ["EVT-003"]);
  assert.deepEqual(subscriptions.getLastErrors(), [{ subscription_id: "SUB-1", event_type: "agent.*", handler: "failingHandler", error: "broken subscriber" }]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].event_type, "agent.*");
});

test("optionally disables a subscription after repeated failures", () => {
  let calls = 0;
  const subscriptions = createSubscriptionRegistry({ maxFailures: 2, logger: { error() {} } });
  subscriptions.subscribe("workflow.*", () => { calls += 1; throw new Error("fail"); });
  subscriptions.publish({ event_type: "workflow.started", event_id: "EVT-1" });
  subscriptions.publish({ event_type: "workflow.started", event_id: "EVT-2" });
  subscriptions.publish({ event_type: "workflow.started", event_id: "EVT-3" });
  assert.equal(calls, 2);
});
