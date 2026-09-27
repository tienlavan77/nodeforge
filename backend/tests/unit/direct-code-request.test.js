// Verifies dashboard code requests become File Service inputs before Supervisor selects a coder.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createDirectCodeRequest } from "../../src/application/direct-code-request.js";
import { createAgentExecutionCheckpointStore } from "../../src/modules/agent/agent-execution-checkpoint.js";

test("direct code saves the exact Vietnamese input and Supervisor result", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-direct-code-"));
  try {
    const files = createFileService({ projectRoot: root });
    const events = [];
    let received;
    const service = createDirectCodeRequest({ fileService: files, checkpoints: createAgentExecutionCheckpointStore({ fileService: files }), projectId: "PROJECT-1", projectLogger: (event) => events.push(event), integration: { submitTicket: async (request) => {
      received = request;
      assert.equal((await files.readFile({ path: `.forge/runtime/nf/code-requests/${request.task_id}.json` })).includes("chỉnh sửa giao diện"), true);
      return { status: "completed", agent_id: "codex-coder", response: "Done." };
    } } });
    const result = await service.run({ projectId: "PROJECT-1", sprintId: "SPRINT-1", text: "chỉnh sửa giao diện\ncho mượt" });
    assert.equal(received.required_role, "coder");
    assert.equal(received.payload.direct_code, true);
    assert.equal(received.ticket.objective, "chỉnh sửa giao diện\ncho mượt");
    assert.equal(result.agent_id, "codex-coder");
    assert.equal(JSON.parse(await files.readFile({ path: result.result_path })).response, "Done.");
    assert.deepEqual(events.map((event) => event.event_name), ["direct_code.started", "direct_code.completed"]);
    await assert.rejects(() => service.run({ projectId: "PROJECT-2", text: "change" }), (error) => error.code === "DIRECT_CODE_INPUT_INVALID");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("direct code records Supervisor failure beside the persisted input", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-direct-code-fail-"));
  try {
    const files = createFileService({ projectRoot: root });
    const service = createDirectCodeRequest({ fileService: files, checkpoints: createAgentExecutionCheckpointStore({ fileService: files }), integration: { submitTicket: async () => { throw Object.assign(new Error("No coder ready."), { code: "AGENT_NOT_AVAILABLE" }); } } });
    await assert.rejects(() => service.run({ projectId: "PROJECT-1", text: "sửa code" }), /No coder ready/);
    const paths = await files.listFiles({ glob: ".forge/runtime/nf/code-requests/*.result.json" });
    assert.equal(paths.length, 1);
    assert.equal(JSON.parse(await files.readFile({ path: paths[0] })).error_code, "AGENT_NOT_AVAILABLE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("direct code logs a result storage failure without hiding the Supervisor error", async () => {
  const events = [];
  const service = createDirectCodeRequest({
    fileService: { atomicCreate: async () => {}, atomicWrite: async () => { throw Object.assign(new Error("Disk unavailable"), { code: "DISK_UNAVAILABLE" }); }, readFile: async () => "" },
    checkpoints: { load: async () => null, listPending: async () => [] },
    projectLogger: (event) => events.push(event),
    integration: { submitTicket: async () => { throw Object.assign(new Error("Coder unavailable"), { code: "AGENT_NOT_AVAILABLE" }); } }
  });
  await assert.rejects(() => service.run({ projectId: "PROJECT-1", text: "sửa code" }), (error) => error.code === "AGENT_NOT_AVAILABLE");
  assert.deepEqual(events.map((event) => event.event_name), ["direct_code.started", "direct_code.result_write_failed", "direct_code.failed"]);
});

test("Resume reuses the saved Vietnamese objective and checkpoint task ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-direct-resume-"));
  try {
    const files = createFileService({ projectRoot: root });
    const checkpoints = createAgentExecutionCheckpointStore({ fileService: files });
    const calls = [];
    const service = createDirectCodeRequest({ fileService: files, checkpoints, projectId: "PROJECT-1", integration: { submitTicket: async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        await checkpoints.save({ task_id: request.task_id, status: "in_progress", last_completed_turn: 25, session_id: "claude-session", agent_id: "coder-1", provider: "claude" });
        throw new Error("Reached maximum number of turns (25)");
      }
      return { status: "completed", agent_id: "coder-1", response: "Finished." };
    } } });
    await assert.rejects(() => service.run({ projectId: "PROJECT-1", sprintId: "SPRINT-1", text: "cập nhật trạng thái agent" }), /maximum number/);
    const [pending] = await service.listPending({ projectId: "PROJECT-1", sprintId: "SPRINT-1" });
    assert.equal(pending.last_completed_turn, 25);
    const result = await service.resume({ projectId: "PROJECT-1", taskId: pending.task_id });
    assert.equal(result.task_id, pending.task_id);
    assert.equal(calls[1].ticket.objective, "cập nhật trạng thái agent");
    assert.equal(calls[1].payload.resume_from.session_id, "claude-session");
    assert.equal(calls[1].payload.resume_from.last_completed_turn, 25);
    await assert.rejects(() => service.resume({ projectId: "PROJECT-1", taskId: "CODE-missing" }), /not found/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
