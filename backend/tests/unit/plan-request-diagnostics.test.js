// Verifies telemetry failures cannot change owner plan persistence, hide core errors or regenerate an artifact.
import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerChatCommandService } from "../../src/application/owner-chat-command-service.js";

const summary = "# Discussion Summary\nAssumption: scope is stable. [Evidence: backend/src/application/owner-chat-command-service.js]";
const markdown = "# Plan: Diagnostic safety\n\n## 1. Objective\nRepository discovery complete. [Evidence: backend/src/application/owner-chat-command-service.js]\n\n## 5. Outcomes\n| Mã | Outcome | Acceptance criteria | Guardrail |\n| --- | --- | --- | --- |\n| O1 | Persist plan | Exact artifact reviewable | No RUN |\n\n## 6. Risks\nAssumption: scope is stable.\n\n## 7. Acceptance\nReview exact identity.";

// Models indexed artifact authority independently from optional diagnostics and lifecycle publication.
function fixture(failure, coreError = null) {
  const artifacts = new Map(); const events = []; const logs = []; const calls = { generation: 0, create: 0, fail: 0 };
  const secret = new Error("TOKEN=never-log-this");
  const requests = {
    start: async () => { if (failure === "start") throw secret; return { request_id: "PLAN-REQUEST-A" }; },
    complete: async () => { if (failure === "complete") throw secret; },
    fail: async () => { calls.fail++; if (failure === "fail") throw secret; }
  };
  const fileService = { readFile: async ({ path }) => path.endsWith("README.md") ? "# Plan frame" : summary, atomicCreate: async () => {} };
  const store = {
    createRevision: async ({ planId, markdown: content, conversationId }) => {
      calls.create++;
      const artifact = { plan_id: planId, revision: 1, sha256: "a".repeat(64), status: "awaiting_human_approval", markdown: content, conversation_id: conversationId };
      artifacts.set(planId, artifact); return artifact;
    },
    getRevision: async ({ planId }) => artifacts.get(planId)
  };
  const service = createOwnerChatCommandService({ projectId: "PROJECT-A", fileService, planStore: { createRevision: async () => {}, assertExecutable: async () => {} }, markdownPlanStore: store, planRequests: requests,
    publishPlanEvent: async (event) => { if (failure === "publication") throw secret; events.push(event); } });
  return { service, store, events, logs, calls, coreError };
}

for (const failure of ["start", "complete", "publication"]) {
  test(`${failure} failure preserves one reviewable plan and reports degraded diagnostics`, async (t) => {
    const context = fixture(failure);
    const logs = [];
    t.mock.method(console, "error", (...args) => logs.push(args));
    const result = await context.service.execute({ text: "/plan SUMMARY-A", conversationId: null, requestArchitecture: async () => { context.calls.generation++; return markdown; } });
    assert.equal(result.status, "awaiting_human_approval");
    assert.equal(result.diagnostics_status, "degraded");
    assert.equal(result.diagnostics_error_code, "PLAN_DIAGNOSTICS_UNAVAILABLE");
    const artifact = await context.store.getRevision({ planId: result.plan_id });
    assert.equal(artifact.sha256, result.sha256); assert.equal(artifact.revision, result.revision);
    assert.equal(context.calls.generation, 1); assert.equal(context.calls.create, 1); assert.equal(context.calls.fail, 0);
    assert.ok(logs.length > 0); assert.doesNotMatch(JSON.stringify(logs), /TOKEN|never-log|Diagnostic safety/);
    if (failure !== "publication") {
      assert.deepEqual(context.events.map((event) => event.event_type), ["plan.request.generating", "plan.request.persisted"]);
      assert.equal(context.events[0].payload.request_id, context.events[1].payload.request_id);
      assert.equal(context.events[1].payload.sha256, artifact.sha256);
    }
  });
}

for (const failure of ["fail", "publication"]) {
  test(`${failure} failure does not replace the original Architecture error`, async (t) => {
    const context = fixture(failure);
    const logs = []; t.mock.method(console, "error", (...args) => logs.push(args));
    const original = Object.assign(new Error("private provider failure"), { code: "ARCHITECTURE_FAILED" });
    await assert.rejects(context.service.execute({ text: "/plan SUMMARY-A", requestArchitecture: async () => { throw original; } }), (error) => error === original);
    assert.equal(context.calls.create, 0);
    assert.doesNotMatch(JSON.stringify(logs), /private provider|TOKEN|never-log/);
    if (failure === "fail") assert.equal(context.events.at(-1).payload.error_code, "ARCHITECTURE_FAILED");
  });
}
