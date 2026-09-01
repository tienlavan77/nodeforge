import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createStage1TicketRunner } from "../../src/modules/workflows/stage1-ticket-runner.js";
import { createStage1TaskRequestBuilder } from "../../src/modules/workflows/stage1-task-request-builder.js";

const source = "export const marker = 'before';\n";
const checksum = `sha256:${createHash("sha256").update(source).digest("hex")}`;
const ticket = {
  id: "FORGE-RUNNER-RETRY-001",
  project_id: "PROJECT-NODEFORGE",
  title: "Update marker",
  objective: "Update the marker in one indexed file.",
  acceptance_criteria: ["Marker is updated."],
  dependencies: []
};

function makeStatusStore() {
  let current;
  return {
    get: () => current,
    create: () => (current = { ticket_id: ticket.id, status: "pending", version: 0 }),
    dependenciesReady: () => ({ ready: true, blocked_by: [] }),
    retry: () => (current = { ...current, status: "pending" }),
    updateStatus: (_id, status, details) => (current = { ...current, status, details, version: (current?.version ?? 0) + 1 })
  };
}

function logger() {
  return { requestSent() {}, responseReceived() {}, failed() {} };
}

function createRunner({ responses } = {}) {
  const statusStore = makeStatusStore();
  const writes = [];
  const requests = [];
  let call = 0;
  const runner = createStage1TicketRunner({
    statusStore,
    gitService: {
      branchExists: async () => false,
      createBranch: async () => {},
      commit: async (_message, { paths }) => ({ sha: "retry-sha", paths })
    },
    protocolLogger: logger(),
    protocolStorage: { save: async () => {} },
    fileService: {
      readFile: async () => source,
      atomicWrite: async (input) => writes.push(input),
      atomicCreate: async () => { throw new Error("unexpected create"); }
    },
    files: { findByPath: () => ({ file_id: "F1", path: "ui/nextjs/app/Test.jsx", language: "javascript", sha256: checksum, size_bytes: source.length }) },
    requestBuilder: createStage1TaskRequestBuilder(),
    agentGateway: {
      request: async ({ payload }) => {
        requests.push(structuredClone(payload));
        const response = responses[call];
        call += 1;
        return response;
      }
    }
  });
  return { runner, statusStore, writes, requests };
}

function codeNeeded() {
  return { payload: { tool_use: { name: "request_info", input: { files_requested: ["ui/nextjs/app/Test.jsx"], reason: "Need source" } } } };
}

function invalidSubmit() {
  return { payload: { tool_use: { name: "submit_code", input: { explanation: "Malformed retry", files: [{ language: "javascript", format: "full_content", content: "bad", exists: true, before_checksum: checksum }] } } } };
}

function validSubmit() {
  return { payload: { tool_use: { name: "submit_code", input: { explanation: "Updated", files: [{ path: "ui/nextjs/app/Test.jsx", language: "javascript", format: "full_content", content: "export const marker = 'after';\n", exists: true, before_checksum: checksum }] } } } };
}

test("retries invalid submission without writing, then applies the valid response", async () => {
  const { runner, writes, requests } = createRunner({ responses: [codeNeeded(), invalidSubmit(), validSubmit()] });
  const result = await runner.run(ticket);

  assert.equal(result.status.status, "done");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].content, "export const marker = 'after';\n");
  assert.equal(requests.length, 3);
  assert.notEqual(requests[2].request_id, requests[1].request_id);
  assert.equal(requests[2].step_id, requests[1].step_id + 1);
  assert.equal(requests[2].metadata.retry_of_step, requests[1].step_id);
  assert.match(requests[2].metadata.previous_error, /path/);
  assert.equal(requests[2].expected_output.representation, "full_content");
});

test("escalates the second retry to full_content and never partially writes invalid responses", async () => {
  const { runner, writes, requests } = createRunner({
    submissionFormat: "unified_diff",
    responses: [codeNeeded(), invalidSubmit(), invalidSubmit(), validSubmit()]
  });
  const formatTicket = { ...ticket, id: "FORGE-RUNNER-RETRY-002", submission_format: "unified_diff" };
  const result = await runner.run(formatTicket);

  assert.equal(result.status.status, "done");
  assert.equal(writes.length, 1);
  assert.equal(requests.length, 4);
  assert.equal(requests[1].expected_output.representation, "unified_diff");
  assert.equal(requests[2].expected_output.representation, "unified_diff");
  assert.equal(requests[3].expected_output.representation, "full_content");
  assert.equal(requests[3].metadata.retry_of_step, requests[2].step_id);
});
