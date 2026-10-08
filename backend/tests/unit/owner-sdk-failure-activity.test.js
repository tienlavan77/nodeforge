// Verifies terminal provider failures emit a sanitized activity only after durable interruption.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("backend/src/application/owner-sdk-stream.js", "utf8");

// Keeps recovery controls dependent on persisted interruption rather than raw provider errors.
test("terminal provider failures publish a safe activity after checkpoint persistence", () => {
  const persist = source.indexOf('await checkpointStore.patch(conversationId, correlationId');
  const activity = source.lastIndexOf('eventSink?.({ event_type: "agent.activity"');
  assert.ok(persist >= 0);
  assert.ok(activity > persist);
  assert.match(source, /\["interrupted", "manual_required"\]\.includes\(persisted\?\.status\)/);
  assert.match(source, /error\.code !== "EXECUTION_PAUSED"/);
  assert.match(source, /error\.code === "EXECUTION_PAUSED"/);
  assert.match(source, /activity_type: "paused"/);
  for (const status of ["429", "500", "404"]) assert.match(source, new RegExp(status));
  assert.match(source, /PROVIDER_TRANSPORT/);
  assert.doesNotMatch(source, /summary: error\.message/);
});
