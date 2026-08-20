import assert from "node:assert/strict";
import test from "node:test";

import { createOwnerRequestService } from "../../src/application/owner-request-service.js";

test("persists Owner Request before dispatch and preserves correlation", async () => {
  const calls = [];
  let service;
  const orchestrator = {
    orchestrate(request) {
      calls.push({ request, persisted: service.getById(request.id) });
      return Promise.resolve({ correlation_id: request.correlation_id, sprint: [] });
    }
  };
  service = createOwnerRequestService({ governanceOrchestrator: orchestrator });
  const input = { request_id: "REQ-129-1", correlation_id: "CORR-129-1", timestamp: "2026-08-20T14:00:00Z", payload: { project_id: "PROJECT-129", vision: "Build governance" }, status: "accepted" };
  const accepted = service.submit(input);
  input.payload.vision = "mutated";
  await Promise.resolve();

  assert.equal(accepted.status, "accepted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].persisted.status, "accepted");
  assert.equal(calls[0].request.correlation_id, "CORR-129-1");
  assert.equal(service.getById("REQ-129-1").payload.vision, "Build governance");
  assert.equal(service.getByCorrelationId("CORR-129-1").status, "completed");
});

test("rejects invalid and duplicate requests deterministically", () => {
  const service = createOwnerRequestService({ governanceOrchestrator: { orchestrate: () => Promise.resolve() } });
  const request = { request_id: "REQ-129-2", correlation_id: "CORR-129-2", timestamp: "2026-08-20T14:00:00Z", payload: { project_id: "PROJECT-129" } };
  assert.throws(() => service.submit({ ...request, payload: undefined }), /requires request_id/);
  assert.throws(() => service.submit({ ...request, payload: { purpose: "missing project" } }), /requires project_id/);
  service.submit(request);
  assert.throws(() => service.submit(request), /already exists/);
  assert.equal(service.getById("REQ-missing"), undefined);
  assert.equal(service.getByCorrelationId("CORR-missing"), undefined);
});
