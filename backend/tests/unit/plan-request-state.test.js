// Verifies persisted planning lifecycle diagnostics without granting approval, retry or execution authority.
import assert from "node:assert/strict";
import test from "node:test";
import { createPlanRequestState } from "../../src/application/plan-request-state.js";
import { routePlan } from "../../src/transport/http/forge-v1-plan-routes.js";

// Supplies a Node File Service double for request-state persistence and read-back witnesses.
function fixture() {
  const files = new Map();
  const fileService = { createLock: async () => ({ release: async () => {} }), readFile: async ({ path }) => { if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files.get(path); }, atomicWrite: async ({ path, content }) => { files.set(path, content); } };
  return { files, fileService, state: createPlanRequestState({ projectId: "PROJECT-A", fileService }) };
}

test("generating request survives service recreation and becomes reviewable only as a persisted artifact identity", async () => {
  const { state, fileService } = fixture();
  const request = await state.start();
  const restored = createPlanRequestState({ projectId: "PROJECT-A", fileService });
  assert.equal((await restored.list())[0].status, "generating");
  assert.equal((await restored.list())[0].plan_id, undefined);
  await state.complete(request, { plan_id: "PLAN-A", revision: 1, sha256: "a".repeat(64) });
  assert.equal((await restored.list())[0].status, "persisted");
  assert.equal((await restored.list())[0].plan_id, "PLAN-A");
  assert.equal((await restored.list())[0].process_id, undefined);
});

test("failure snapshot contains safe code, not token, exception message or generated content", async () => {
  const { state } = fixture(); const request = await state.start();
  await state.fail(request, Object.assign(new Error("Bearer SECRET full plan content"), { code: "ARCHITECTURE_UNAVAILABLE" }));
  const result = await state.list();
  assert.equal(result[0].status, "failed"); assert.equal(result[0].error_code, "ARCHITECTURE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result), /SECRET|Bearer|full plan content/);
});

test("another live local process is not falsely classified as interrupted", async () => {
  const { state, files } = fixture();
  files.set(".forge/runtime/nf/plan-requests/PROJECT-A.json", JSON.stringify([{ request_id: "OTHER", status: "generating", process_id: "OTHER-BOOT", process_pid: process.pid, project_id: "PROJECT-A" }]));
  assert.equal((await state.list())[0].status, "generating");
});

test("snapshot corruption and persistence failure remain visible instead of fabricating an empty success", async () => {
  const { state, files, fileService } = fixture();
  files.set(".forge/runtime/nf/plan-requests/PROJECT-A.json", "invalid json");
  await assert.rejects(state.list(), SyntaxError);
  files.clear(); fileService.atomicWrite = async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
  await assert.rejects(state.start(), { code: "ENOSPC" });
});

test("request snapshot route remains project isolated and unavailable if lifecycle service is not wired", async () => {
  const { state } = fixture(); await state.start();
  const context = { method: "GET", parts: ["plans", "requests"], projectId: "PROJECT-A", expectedProjectId: "PROJECT-A", planStore: {}, planRequests: state };
  assert.equal((await routePlan(context)).body[0].status, "generating");
  await assert.rejects(routePlan({ ...context, projectId: "PROJECT-B" }), { code: "PROJECT_CONTEXT_CONFLICT" });
  await assert.rejects(routePlan({ ...context, planRequests: null }));
});
