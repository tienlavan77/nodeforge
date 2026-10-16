// Verifies Coder scope blockers reach owner review without fake completion or verification.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { createReportDoneTool } from "../../src/tools/agent-report-tool.js";
import { assertTicketExecutionCompleted, collectToolCalls, sdkToolEvent } from "../../src/modules/supervisor/nodeforge-task-sdk-events.js";
import { handleTicketExecutionFailure } from "../../src/modules/supervisor/ticket-execution-failure.js";

const ticket = { id: "TICKET-LIFECYCLE", acceptance_criteria: ["Implement approved project management contract"] };
const input = {
  status: "blocked",
  summary: "No compatible management contract identified; no changes or tests claimed.",
  blocker: { reason_code: "CONTRACT_DECISION_REQUIRED", owner_action: "Identify or approve the management transport contract." },
  evidence: [{ type: "source", reference: "backend/src/transport/http/forge-v1-router.js:14", result: "No compatible lifecycle contract identified." }]
};

test("blocked report schema requires explicit reason, owner action and evidence", async () => {
  const schema = JSON.parse(await readFile(new URL("../../../schemas/agent/tools/report-done.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(input), true);
  for (const invalid of [{ ...input, evidence: [] }, { ...input, blocker: {} }, { ...input, status: "completed" }, { ...input, status: undefined }]) assert.equal(validate(invalid), false);
  assert.equal(validate({ summary: "Done" }), true);
});

test("discovery-only blocker is durable and cannot enter completion through either SDK", async () => {
  let saved;
  let written;
  let verificationCalls = 0;
  const tool = createReportDoneTool({
    reportService: {
      buildFinalReport: async (report) => ({ ...report }),
      saveReport: async (_taskId, report) => { saved = report; },
      writeReportFile: async (_taskId, report) => { written = report; }
    },
    verificationService: { ensurePassedArtifact: async () => { verificationCalls++; throw new Error("No committed context"); } }
  });
  let diagnostic;
  await assert.rejects(tool.execute(input, { ticket, changed_paths: [] }), (error) => {
    diagnostic = { error_code: error.code, message: error.message };
    return error.code === "CODER_BLOCKED";
  });
  assert.equal(verificationCalls, 0);
  assert.equal(saved, written);
  assert.equal(saved.status, "needs_human_review");
  assert.equal(saved.verifyResult, null);
  assert.deepEqual(saved.filesChanged, []);
  assert.deepEqual(saved.agent_report.blocker, input.blocker);
  assert.equal(saved.criteria_check[0].node_verified, null);
  const content = [{ type: "text", text: JSON.stringify(diagnostic) }];
  const codex = [sdkToolEvent({ type: "item.completed", item: { type: "mcp_tool_call", name: "report_done", status: "failed", result: { content } } })];
  const codexMcpError = [sdkToolEvent({ type: "item.completed", item: { type: "mcp_tool_call", name: "report_done", status: "completed", result: { isError: true, content } } })];
  const claude = collectToolCalls([
    { content: [{ type: "tool_use", id: "blocked", name: "mcp__forge__report_done" }] },
    { content: [{ type: "tool_result", tool_use_id: "blocked", is_error: true, content }] }
  ]);
  for (const events of [codex, codexMcpError, claude]) {
    let completionReached = false;
    assert.throws(() => { assertTicketExecutionCompleted(events); completionReached = true; }, { code: "CODER_BLOCKED", message: diagnostic.message });
    assert.equal(completionReached, false);
  }
});

test("owner escalation retains checkpoint evidence and never emits failed or completed", async () => {
  for (const claim of [{ claim_id: "CLAIM-1" }, null]) {
    let checkpoint = { task_id: ticket.id, status: "blocked", last_completed_turn: 12, changed_paths: [] };
    const outcomes = [];
    const releases = [];
    await handleTicketExecutionFailure({
      error: Object.assign(new Error(input.summary), { code: "CODER_BLOCKED" }),
      failedRequest: { task_id: ticket.id, correlation_id: "CORR-1" }, taskId: ticket.id, ownerId: "SUP-1", claim,
      checkpoints: { load: async () => checkpoint, save: async (value) => { checkpoint = value; } },
      agentOccupancy: { release: async (value) => releases.push(value) }, projectLogger: () => {},
      publishTicketOutcome: async (type, _request, _owner, payload) => outcomes.push({ type, payload })
    });
    assert.equal(checkpoint.phase, "owner_decision");
    assert.equal(checkpoint.status, "blocked");
    assert.equal(checkpoint.last_completed_turn, 12);
    assert.deepEqual(checkpoint.changed_paths, []);
    assert.equal(releases.length, claim ? 1 : 0);
    assert.deepEqual(outcomes.map((outcome) => outcome.type), ["task.needs_human_review"]);
    assert.equal(outcomes[0].payload.retryable, false);
  }
});

test("completion still requires verification and text alone cannot bypass it", async () => {
  let calls = 0;
  const tool = createReportDoneTool({
    reportService: { buildFinalReport: async () => assert.fail("Must not save completion"), saveReport: async () => {}, writeReportFile: async () => {} },
    verificationService: { ensurePassedArtifact: async () => { calls++; throw Object.assign(new Error("No committed context"), { code: "VERIFY_RECOVERY_BLOCKED" }); } }
  });
  await assert.rejects(tool.execute({ summary: "BLOCKED / NOT ACCEPTED FOR PRODUCTION" }, { ticket }), { code: "VERIFY_RECOVERY_BLOCKED" });
  assert.equal(calls, 1);
  await assert.rejects(tool.execute({ status: "blocked", summary: "Blocked" }, { ticket }), { code: "INPUT_INVALID" });
  assert.equal(calls, 1);
});
