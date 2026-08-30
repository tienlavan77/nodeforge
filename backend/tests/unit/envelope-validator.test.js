import test from "node:test";
import assert from "node:assert/strict";

import { assertValidEnvelope, validateEnvelope } from "../../src/modules/protocol/envelope-validator.js";

const base = {
  request_id: "a1b2c3d4-0001-4000-8000-000000000001",
  parent_id: null,
  role: "agent",
  timestamp: "2026-08-30T10:00:00.000Z"
};

test("validates envelope and payload selected by role:type", () => {
  const result = validateEnvelope({ ...base, type: "no_wiring_needed", payload: { reason: "No import changes are required." } });
  assert.equal(result.valid, true);
  assert.match(result.schema_id, /agent-no-wiring-needed/);
});

test("rejects an invalid payload with a dedicated error code", () => {
  const result = validateEnvelope({ ...base, type: "completed", payload: { status: "completed" } });
  assert.equal(result.valid, false);
  assert.equal(result.code, "INVALID_PAYLOAD");
});

test("supports optional state validation without requiring a state machine", () => {
  const message = { ...base, type: "usage_needed", payload: { files_requested: ["src/app.js"], reason: "Need caller context." } };
  assert.equal(validateEnvelope(message).valid, true);
  assert.equal(validateEnvelope(message, { state: { expectedType: "no_wiring_needed" } }).code, "INVALID_PROTOCOL_STATE");
});

test("rejects unsupported role:type and assert helper throws", () => {
  const message = { ...base, role: "node", type: "completed", payload: {} };
  const result = validateEnvelope(message);
  assert.equal(result.valid, false);
  assert.equal(result.code, "UNSUPPORTED_PAYLOAD_TYPE");
  assert.throws(() => assertValidEnvelope(message), /UNSUPPORTED_PAYLOAD_TYPE/);
});

test("rejects malformed envelope shape before consulting payload registry", () => {
  const cases = [
    { ...base, request_id: "not-a-uuid", type: "no_wiring_needed", payload: { reason: "x" } },
    { ...base, type: "no_wiring_needed", payload: { reason: "x" }, timestamp: "not-a-date" },
    { ...base, role: "operator", type: "no_wiring_needed", payload: { reason: "x" } },
    { ...base, type: "no_wiring_needed" }
  ];
  for (const message of cases) {
    const result = validateEnvelope(message);
    assert.equal(result.valid, false);
    assert.equal(result.code, "INVALID_ENVELOPE");
  }
});

test("validates every registered Agent payload branch", () => {
  const payloads = {
    code_needed: { files_requested: ["backend/src/app.js"], reason: "Need the current implementation." },
    submit_code_response: {
      explanation: "Updated the implementation.",
      files: [{ path: "backend/src/app.js", language: "javascript", format: "full", content: "export {};", exists: true }]
    },
    usage_needed: { files_requested: ["backend/src/index.js"], reason: "Need the caller to wire this module." },
    no_wiring_needed: { reason: "The new module is already reachable." },
    completed: { status: "completed", report: { summary: "Done.", files_changed: [], criteria_check: [] } },
    continue: { status: "continue", next_task: { description: "Inspect the integration point." } }
  };
  for (const [type, payload] of Object.entries(payloads)) {
    assert.equal(validateEnvelope({ ...base, type, payload }).valid, true, `invalid ${type}`);
  }
});

test("payload schemas reject missing fields and unexpected fields", () => {
  const invalidMessages = [
    { ...base, type: "code_needed", payload: { reason: "missing files" } },
    { ...base, type: "usage_needed", payload: { files_requested: ["x"] } },
    { ...base, type: "no_wiring_needed", payload: { reason: "ok", extra: true } },
    { ...base, type: "continue", payload: { status: "continue", next_task: {} } }
  ];
  for (const message of invalidMessages) {
    const result = validateEnvelope(message);
    assert.equal(result.valid, false);
    assert.equal(result.code, "INVALID_PAYLOAD");
  }
});

test("validator result has a stable contract and assert helper preserves valid envelope", () => {
  const message = { ...base, type: "no_wiring_needed", payload: { reason: "No wiring required." } };
  const result = validateEnvelope(message);
  assert.deepEqual(Object.keys(result).sort(), ["envelope", "schema_id", "valid"].sort());
  assert.strictEqual(assertValidEnvelope(message), message);

  const invalid = validateEnvelope({ ...message, payload: {} });
  assert.equal(invalid.valid, false);
  assert.equal(typeof invalid.code, "string");
  assert.equal(Array.isArray(invalid.errors), true);
});
