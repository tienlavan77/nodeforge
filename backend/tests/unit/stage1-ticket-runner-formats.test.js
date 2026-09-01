import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createStage1TicketRunner } from "../../src/modules/workflows/stage1-ticket-runner.js";
import { createStage1TaskRequestBuilder } from "../../src/modules/workflows/stage1-task-request-builder.js";

const source = "export const marker = 'before';\n";
const checksum = `sha256:${createHash("sha256").update(source).digest("hex")}`;

function createHarness(format) {
  const ticket = { id: `FORGE-FORMAT-${format}`, project_id: "PROJECT-NODEFORGE", title: "Update marker", objective: "Update one indexed marker.", acceptance_criteria: ["Marker is updated."], dependencies: [], submission_format: format };
  let status;
  let call = 0;
  let current = source;
  const requests = [];
  const writes = [];
  const responses = [
    { payload: { tool_use: { name: "request_info", input: { files_requested: ["ui/nextjs/app/FormatTarget.jsx"], reason: "Need source" } } } },
    { payload: { tool_use: { name: "submit_code_response", input: { explanation: "Updated", files: [{ path: "ui/nextjs/app/FormatTarget.jsx", language: "javascript", format, content: format === "unified_diff" ? "--- a/ui/nextjs/app/FormatTarget.jsx\n+++ b/ui/nextjs/app/FormatTarget.jsx\n@@ -1,1 +1,1 @@\n-export const marker = 'before';\n+export const marker = 'after';\n" : "*** Begin Patch\n*** Update File: ui/nextjs/app/FormatTarget.jsx\n@@\n-export const marker = 'before';\n+export const marker = 'after';\n*** End Patch", exists: true, before_checksum: checksum }] } } } }
  ];
  const statusStore = {
    get: () => status,
    create: () => (status = { ticket_id: ticket.id, status: "pending", version: 0 }),
    dependenciesReady: () => ({ ready: true, blocked_by: [] }),
    updateStatus: (_id, next, details) => (status = { ...status, status: next, details, version: (status?.version ?? 0) + 1 }),
    retry: () => (status = { ...status, status: "pending" })
  };
  const runner = createStage1TicketRunner({
    statusStore,
    gitService: { branchExists: async () => false, createBranch: async () => {}, commit: async (_message, options) => ({ sha: "format-run-sha", paths: options.paths }) },
    protocolLogger: { requestSent() {}, responseReceived() {}, failed() {} },
    protocolStorage: { save: async () => {} },
    fileService: { readFile: async () => current, atomicWrite: async ({ content }) => { writes.push(content); current = content; }, atomicCreate: async () => {} },
    files: { findByPath: () => ({ path: "ui/nextjs/app/FormatTarget.jsx", language: "javascript", sha256: checksum, size_bytes: source.length }) },
    requestBuilder: createStage1TaskRequestBuilder(),
    agentGateway: { request: async ({ payload }) => { requests.push(structuredClone(payload)); return responses[call++]; } }
  });
  return { runner, ticket, requests, writes };
}

for (const format of ["unified_diff", "apply_patch"]) {
  test(`runs the complete Stage-1 pipeline with ${format}`, async () => {
    const { runner, ticket, requests, writes } = createHarness(format);
    const result = await runner.run(ticket);
    assert.equal(result.status.status, "done");
    assert.deepEqual(writes, ["export const marker = 'after';\n"]);
    assert.equal(requests[1].expected_output.representation, format);
    assert.equal(requests[1].user_blocks.at(-1).content.includes(format), true);
  });
}
