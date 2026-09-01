import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createProtocolStorage } from "../../src/infrastructure/storage/protocol-storage.js";
import { createProtocolStepLogger } from "../../src/modules/protocol/protocol-step-logger.js";
import { createStage1TaskInitializer } from "../../src/modules/workflows/stage1-task-initializer.js";
import { createStage1TaskRequestBuilder } from "../../src/modules/workflows/stage1-task-request-builder.js";
import { createStage1RequestSender } from "../../src/modules/workflows/stage1-request-sender.js";
import { createStage1ResponseReceiver } from "../../src/modules/workflows/stage1-response-receiver.js";
import { createStage1ResponseRouter } from "../../src/modules/workflows/stage1-response-router.js";
import { createStage1CodeNeededHandler } from "../../src/modules/workflows/stage1-code-needed-handler.js";
import { createStage1SubmitCodeHandler } from "../../src/modules/workflows/stage1-submit-code-handler.js";
import { stage1AgentProfile, stage1Target, stage1Ticket } from "../fixtures/stage1-openai-fixture.js";

const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];

function baseFlow({ adapterCall, fileService, statusStore, gitService, protocolStorage, logs }) {
  const logger = createProtocolStepLogger({ logger: { info: (_message, entry) => logs.push(entry), error: (_message, entry) => logs.push(entry) } });
  const initializer = createStage1TaskInitializer({ statusStore, gitService, protocolLogger: logger, createRequestId: () => ids[0] });
  const requestBuilder = createStage1TaskRequestBuilder({ createRequestId: () => ids[1], conventions: ["Use File Service."] });
  const sender = createStage1RequestSender({ adapterResolver: () => ({ call: adapterCall }), protocolLogger: logger, protocolStorage });
  const receiver = createStage1ResponseReceiver({ protocolLogger: logger });
  const codeHandler = createStage1CodeNeededHandler({ files: { findByPath: (path) => path === stage1Target.path ? { file_id: "F1", path, language: "text" } : null }, fileService, createRequestId: () => ids[2] });
  const submitHandler = createStage1SubmitCodeHandler({ fileService, gitService, statusStore, protocolLogger: logger });
  return { initializer, requestBuilder, sender, receiver, codeHandler, submitHandler };
}

function statusFixture() {
  let current = { ticket_id: stage1Ticket.id, status: "pending", version: 0 };
  return { get: () => current, create: () => current, dependenciesReady: () => ({ ready: true, blocked_by: [] }), updateStatus: (_id, status, details) => { current = { ...current, status, version: current.version + 1, details }; return current; }, current: () => current };
}

test("runs stage-1 mock flow from task to reviewing with persisted rounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-stage1-flow-"));
  const fileService = createFileService({ projectRoot: root });
  const protocolStorage = createProtocolStorage({ projectRoot: root, fileService });
  await fileService.atomicCreate({ path: stage1Target.path, content: "before marker\n" });
  const statusStore = statusFixture(); const branches = new Set(); const commits = []; const logs = [];
  const gitService = { branchExists: async (name) => branches.has(name), createBranch: async (name) => { branches.add(name); }, commit: async (message, options) => { commits.push({ message, options }); return { sha: "COMMIT-STAGE1" }; } };
  let calls = 0;
  const adapterCall = async ({ payload }) => { calls += 1; if (calls === 1) return { request_id: ids[2], parent_id: payload.request_id, type: "code_needed", role: "agent", payload: { files_requested: [stage1Target.path], reason: "Need file" }, timestamp: new Date().toISOString() }; return { request_id: ids[3], parent_id: payload.request_id, type: "submit_code_response", role: "agent", payload: { explanation: "Created marker", files: [{ path: stage1Target.path, language: "text", format: "full", content: stage1Target.content, exists: true, before_checksum: "sha256:7e6a9cbffe9b8504d17ad6bf77355a83bd450448c08c02764101a6eb381eb00a" }] }, timestamp: new Date().toISOString() }; };
  const flow = baseFlow({ adapterCall, fileService, statusStore, gitService, protocolStorage, logs });
  const initialized = await flow.initializer.initTask(stage1Ticket); assert.equal(initialized.status.status, "running");
  const task = flow.requestBuilder.buildTaskRequest(stage1Ticket, { agentId: stage1AgentProfile.agent_id });
  const first = await flow.sender.sendRequest(task, { agentProfile: stage1AgentProfile });
  const needed = flow.receiver.receiveResponse(first.response, { requestEnvelope: task });
  const provide = await flow.codeHandler.handleCodeNeeded(needed, { requestEnvelope: task });
  const second = await flow.sender.sendRequest(provide, { agentProfile: stage1AgentProfile });
  const submitted = flow.receiver.receiveResponse(second.response, { requestEnvelope: provide });
  const routed = createStage1ResponseRouter({ onCodeNeeded: () => "unexpected", onSubmitCode: (envelope) => flow.submitHandler.handleSubmitCode(envelope, { taskId: stage1Ticket.id, ticketId: stage1Ticket.id }) });
  const result = await routed.routeResponse(submitted);
  assert.equal(result.status.status, "reviewing"); assert.equal(await readFile(join(root, stage1Target.path), "utf8"), stage1Target.content); assert.equal(commits[0].options.paths[0], stage1Target.path); assert.deepEqual(await protocolStorage.list(stage1Ticket.id), [`task/${stage1Ticket.id}/round_1/request`, `task/${stage1Ticket.id}/round_1/response`, `task/${stage1Ticket.id}/round_2/request`, `task/${stage1Ticket.id}/round_2/response`]); assert.equal(calls, 2); assert.ok(logs.some((entry) => entry.event === "request_sent"));
});

test("failure paths block before agent, reject unsupported response/format, and avoid commit on write failure", async () => {
  let called = false; const blocked = statusFixture(); blocked.dependenciesReady = () => ({ ready: false, blocked_by: [{ id: "DEP", status: "failed" }] }); const branches = new Set(); const init = createStage1TaskInitializer({ statusStore: blocked, gitService: { branchExists: async () => false, createBranch: async () => branches.add("branch") }, protocolLogger: { requestSent() {}, failed() {} }, createRequestId: () => ids[0] }); assert.equal((await init.initTask(stage1Ticket)).status.status, "blocked"); assert.equal(branches.size, 0);
  const router = createStage1ResponseRouter({ onCodeNeeded: () => {}, onSubmitCode: () => {} }); await assert.rejects(() => router.routeResponse({ role: "agent", type: "completed", payload: {} }), /does not support/);
  const fileService = { atomicCreate: async () => { called = true; }, atomicWrite: async () => { called = true; } }; const handler = createStage1SubmitCodeHandler({ fileService, gitService: { commit: async () => { throw new Error("must not commit"); } }, statusStore: statusFixture() }); await assert.rejects(() => handler.handleSubmitCode({ role: "agent", type: "submit_code_response", payload: { files: [{ path: "x", format: "unified_diff", content: "bad", exists: false }] } }, { taskId: stage1Ticket.id }), (error) => error.code === "SUBMISSION_FORMAT_UNSUPPORTED"); assert.equal(called, false);
});
