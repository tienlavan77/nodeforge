import assert from "node:assert/strict";
import test from "node:test";
import { createProtocolStepLogger } from "../../src/modules/protocol/protocol-step-logger.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const parentId = "22222222-2222-4222-8222-222222222222";
const context = { task_id: "FORGE-TEST-001", step_id: 2, type: "code_needed", role: "agent", request_id: requestId, parent_id: parentId };

test("logs request and response metadata in the shared protocol shape", () => {
  const entries = [];
  const service = createProtocolStepLogger({ logger: { info: (_message, fields) => entries.push(fields), error: () => {} }, clock: () => new Date("2026-08-31T10:00:00.000Z") });
  const sent = service.requestSent(context);
  const received = service.responseReceived({ ...context, type: "code_provide", role: "node", duration_ms: 125, status: "ok" });
  assert.equal(sent.event, "request_sent");
  assert.equal(sent.status, "sent");
  assert.equal(received.duration_ms, 125);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].timestamp, "2026-08-31T10:00:00.000Z");
  assert.equal("payload" in entries[0], false);
});

test("logs failures and rejects invalid or content-bearing metadata", () => {
  const errors = [];
  const service = createProtocolStepLogger({ logger: { info() {}, error: (_message, fields) => errors.push(fields) } });
  const result = service.failed(context);
  assert.equal(result.status, "failed");
  assert.equal(errors.length, 1);
  assert.throws(() => service.requestSent({ ...context, request_id: "not-a-uuid" }), /request_id must be a UUID/);
  assert.throws(() => service.requestSent({ ...context, payload: { secret: true } }), /metadata only/);
  assert.throws(() => service.responseReceived({ ...context, duration_ms: -1 }), /non-negative/);
});
