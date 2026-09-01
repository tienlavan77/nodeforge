import assert from "node:assert/strict";
import test from "node:test";
import { createStage1ResponseReceiver } from "../../src/modules/workflows/stage1-response-receiver.js";

const request = { request_id: "11111111-1111-4111-8111-111111111111", payload: { task_id: "FORGE-STAGE1-001", step_id: 1 } };
const response = { request_id: "22222222-2222-4222-8222-222222222222", parent_id: request.request_id, type: "code_needed", role: "agent", payload: { files_requested: ["src/a.js"], reason: "inspect" }, timestamp: "2026-08-31T00:00:00.000Z" };

function receiver(events) { return createStage1ResponseReceiver({ protocolLogger: { responseReceived: (entry) => events.push({ event: "received", ...entry }), failed: (entry) => events.push({ event: "failed", ...entry }) } }); }

test("validates normalized response and logs response_received", () => {
  const events = []; const result = receiver(events).receiveResponse(response, { requestEnvelope: request, startedAt: Date.now() - 10 });
  assert.equal(result.type, "code_needed"); assert.equal(events[0].event, "received"); assert.equal(events[0].status, "received"); assert.ok(events[0].duration_ms >= 0);
});

test("rejects parent mismatch, invalid payload, and wrong role", () => {
  for (const bad of [{ ...response, parent_id: "33333333-3333-4333-8333-333333333333" }, { ...response, payload: { reason: "missing files" } }, { ...response, role: "node" }]) {
    const events = []; assert.throws(() => receiver(events).receiveResponse(bad, { requestEnvelope: request }), /parent_id|INVALID_PAYLOAD|role=agent/); assert.equal(events.at(-1).event, "failed");
  }
});
