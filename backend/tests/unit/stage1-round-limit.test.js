import assert from "node:assert/strict";
import test from "node:test";
import { createStage1TicketRunner } from "../../src/modules/workflows/stage1-ticket-runner.js";
import { createStage1TaskRequestBuilder } from "../../src/modules/workflows/stage1-task-request-builder.js";

const ticket = { id: "FORGE-ROUND-LIMIT-001", project_id: "PROJECT-NODEFORGE", title: "Limit rounds", objective: "Stop after one provider request.", acceptance_criteria: ["Round limit is enforced."], dependencies: [] };
test("round limit escalates to needs_human_review without calling provider again", async () => {
  let current;
  let calls = 0;
  const statusStore = { get: () => current, create: () => (current = { ticket_id: ticket.id, status: "pending", version: 0 }), dependenciesReady: () => ({ ready: true, blocked_by: [] }), updateStatus: (_id, status) => (current = { ...current, status, version: current.version + 1 }), retry: () => current };
  const runner = createStage1TicketRunner({ maxRounds: 1, statusStore, gitService: { branchExists: async () => false, createBranch: async () => {}, commit: async () => ({}) }, protocolLogger: { requestSent() {}, responseReceived() {}, failed() {} }, fileService: { readFile: async () => "", atomicWrite: async () => {}, atomicCreate: async () => {} }, files: { findByPath: () => null }, requestBuilder: createStage1TaskRequestBuilder(), agentGateway: { request: async () => { calls += 1; return { payload: { tool_use: { name: "request_info", input: { files_requested: ["missing.jsx"], reason: "Need source" } } } }; } } });
  await assert.rejects(() => runner.run(ticket), (error) => error.code === "ROUND_LIMIT_EXCEEDED");
  assert.equal(calls, 1);
  assert.equal(current.status, "needs_human_review");
});
