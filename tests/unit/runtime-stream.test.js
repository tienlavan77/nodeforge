import assert from "node:assert/strict";
import test from "node:test";

import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { createRuntimeSse } from "../../src/transport/sse/runtime-stream.js";

test("streams subscribed Agent events and stops after unsubscribe", () => {
  const subscriptions = createSubscriptionRegistry();
  const stream = createRuntimeSse({ subscriptions });
  const chunks = [];
  let ended = false;
  const connection = stream.connect({
    writeHead(status, headers) { assert.equal(status, 200); assert.equal(headers["content-type"], "text/event-stream; charset=utf-8"); },
    write(chunk) { chunks.push(chunk); },
    end() { ended = true; }
  });

  publish(subscriptions, "agent.started", "EVT-106-1");
  publish(subscriptions, "agent.step.completed", "EVT-106-2");
  publish(subscriptions, "agent.completed", "EVT-106-3");
  publish(subscriptions, "agent.unknown", "EVT-106-4");
  assert.equal(chunks.length, 3);
  assert.match(chunks[0], /event: agent\.started/);
  assert.match(chunks[1], /event: agent\.step\.completed/);
  assert.match(chunks[2], /event: agent\.completed/);

  assert.equal(connection.close(), true);
  assert.equal(connection.close(), false);
  publish(subscriptions, "agent.started", "EVT-106-5");
  assert.equal(chunks.length, 3);
  assert.equal(ended, true);
});

function publish(subscriptions, event_type, event_id) {
  subscriptions.publish({ event_type, event_id, payload: {}, metadata: {} });
}
