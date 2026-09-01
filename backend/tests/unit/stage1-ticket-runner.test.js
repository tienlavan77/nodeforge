import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createStage1TicketRunner } from "../../src/modules/workflows/stage1-ticket-runner.js";
import { createStage1TaskRequestBuilder } from "../../src/modules/workflows/stage1-task-request-builder.js";

const ticket = { id: "FORGE-RUNNER-001", project_id: "PROJECT-NODEFORGE", title: "Update marker", objective: "Update one indexed file.", acceptance_criteria: ["Marker is updated."], dependencies: [] };

function statusStore() {
  let current;
  return { get: () => current, create: () => (current = { ticket_id: ticket.id, status: "pending", version: 0 }), dependenciesReady: () => ({ ready: true, blocked_by: [] }), retry: () => (current = { ...current, status: "pending" }), updateStatus: (_id, status, details) => (current = { ...current, status, details, version: (current?.version ?? 0) + 1 }) };
}
function logger() { return { requestSent() {}, responseReceived() {}, failed() {} }; }

test("runs code_needed to submit_code_response through the canonical Stage-1 runner", async () => {
  const current = "before\n"; const checksum = `sha256:${createHash("sha256").update(current).digest("hex")}`; const writes = []; const saved = []; let calls = 0; let profileResolved = false;
  const status = statusStore();
  const terminalStatuses = [];
  const runner = createStage1TicketRunner({
    statusStore: status,
    gitService: { branchExists: async () => false, createBranch: async () => {}, commit: async (_message, { paths }) => ({ sha: "abc", paths }) },
    protocolLogger: logger(), protocolStorage: { save: async (ref) => saved.push(ref) },
    fileService: { readFile: async () => current, atomicWrite: async (input) => writes.push(input), atomicCreate: async () => { throw new Error("must not create"); } },
    files: { findByPath: () => ({ file_id: "F1", path: "ui/nextjs/app/Test.jsx", language: "javascript", sha256: checksum, size_bytes: Buffer.byteLength(current) }) },
    requestBuilder: createStage1TaskRequestBuilder(),
    onStatusChange: (change) => terminalStatuses.push(change),
    resolveAgentProfile: () => { profileResolved = true; return { provider: "codex", gateway_url: "https://gateway.test", model: "gpt-5.6-sol" }; },
    agentGateway: { request: async ({ tools }) => { calls += 1; assert.ok(Array.isArray(tools)); assert.ok(tools.every((tool) => tool.name !== "agent_tool")); return calls === 1
      ? { payload: { tool_use: { name: "request_info", input: { files_requested: ["ui/nextjs/app/Test.jsx"], reason: "Need source" } } } }
      : { payload: { tool_use: { name: "submit_code", input: { explanation: "Updated", files: [{ path: "ui/nextjs/app/Test.jsx", language: "javascript", format: "full_content", content: "after\n", exists: true, before_checksum: checksum }] } } } }; } }
  });
  const result = await runner.run(ticket);
  assert.equal(profileResolved, true); assert.equal(calls, 2); assert.equal(writes.length, 1); assert.equal(result.status.status, "done");
  assert.deepEqual(terminalStatuses.map(({ status }) => status), ["done"]);
  assert.deepEqual(saved.map((ref) => ref.replace(/round_\d+/, "round_N")), ["task/FORGE-RUNNER-001/round_N/request", "task/FORGE-RUNNER-001/round_N/response", "task/FORGE-RUNNER-001/round_N/request", "task/FORGE-RUNNER-001/round_N/response"]);
});

test("moves a running ticket to failed when provider execution fails", async () => {
  const status = statusStore();
  const runner = createStage1TicketRunner({ statusStore: status, gitService: { branchExists: async () => false, createBranch: async () => {}, commit: async () => ({}) }, protocolLogger: logger(), fileService: { readFile: async () => "", atomicWrite: async () => {}, atomicCreate: async () => {} }, files: { findByPath: () => null }, requestBuilder: createStage1TaskRequestBuilder(), agentGateway: { request: async () => { throw new Error("provider down"); } } });
  await assert.rejects(() => runner.run(ticket), /provider down/); assert.equal(status.get().status, "failed");
});
