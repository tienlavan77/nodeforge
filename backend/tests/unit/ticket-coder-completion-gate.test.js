// Verifies pending acceptance evidence cannot produce a terminal ticket completion.
import assert from "node:assert/strict";
import test from "node:test";
import { createCompletionReportService } from "../../src/modules/supervisor/completion-report-service.js";
import { completeCoderTicket, finalizeCoderWorkspace } from "../../src/modules/supervisor/ticket-coder-completion.js";

// Builds a workspace with a persisted report and tracks irreversible transitions.
function workspaceWithReport(status) {
  const actions = [];
  const report = { status: "submitted_for_review", ticket: { id: "TICKET-2", title: "UI behavior", objective: "Verify behavior" }, agent_report: { acceptance_criteria: ["UI behavior"] }, criteria_check: [{ criterion_id: "AC-1", criterion: "UI behavior", status, node_verified: status === "verified" }] };
  const reportService = createCompletionReportService({ protocolStorage: { get: async () => ({ data: report }), save: async () => {} }, fileService: { atomicWrite: async () => {} } });
  const workspace = { testService: { assertPassedArtifact: async () => ({ artifact_id: "ARTIFACT-1", commit_sha: "a".repeat(40) }) }, reportService,
    executionContexts: { load: async () => ({ state: "verified", version: 1 }), update: async () => { actions.push("context_update"); } },
    integrate: async () => { actions.push("integrate"); }, changeLedger: { release: async () => { actions.push("release_ledger"); } } };
  return { workspace, actions };
}

// Requires human evidence before integration and emits a matching ticket status.
test("legacy pending Coder evidence fails retryably without human review, integration or done", async () => {
  const { workspace, actions } = workspaceWithReport("evidence_pending");
  await assert.rejects(finalizeCoderWorkspace(workspace, "TICKET-1"), { code: "CODER_EVIDENCE_PENDING" });
  assert.deepEqual(actions, []);
  const events = [];
  const claimReleases = [];
  const result = await completeCoderTicket({ workspace, agentOccupancy: { release: async (entry) => { claimReleases.push(entry); } }, claim: { claim_id: "CLAIM-1" }, taskId: "TICKET-1", ownerId: "SUP-1", request: { request_id: "REQ-1" }, publishTicketOutcome: async (type, _request, _owner, payload) => { events.push({ type, payload }); }, result: { tool_events: [{ tool: "report_done", status: "success" }] } });
  assert.deepEqual(result, { status: "failed", reason: "CODER_EVIDENCE_PENDING" });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "task.failed");
  assert.equal(events[0].payload.retryable, true);
  assert.equal(events[0].payload.error.code, "CODER_EVIDENCE_PENDING");
  assert.deepEqual(events[0].payload.criterion_ids, ["AC-1"]);
  assert.equal(claimReleases.length, 1);
  assert.deepEqual(actions, ["release_ledger"]);
});

// Lets a fully verified report continue through the existing terminal path.
test("verified Coder evidence can enter integration", async () => {
  const { workspace, actions } = workspaceWithReport("verified");
  await finalizeCoderWorkspace(workspace, "TICKET-2");
  assert.deepEqual(actions, ["context_update", "integrate", "context_update", "release_ledger"]);
});

// Emits done only after verified integration and never requests Human Review for a successful report.
test("successful verified report completes the ticket after integration", async () => {
  const { workspace, actions } = workspaceWithReport("verified");
  const events = [];
  const result = await completeCoderTicket({ workspace, agentOccupancy: { release: async () => { actions.push("release_agent"); } }, claim: { claim_id: "CLAIM-1" }, taskId: "TICKET-2", ownerId: "SUP-1", request: { request_id: "REQ-1" }, publishTicketOutcome: async (type, _request, _owner, payload) => { events.push({ type, payload }); actions.push(type); }, result: { summary: "Verified change", tool_events: [{ tool: "report_done", status: "success" }] } });
  assert.deepEqual(result, { status: "completed" });
  assert.deepEqual(actions, ["context_update", "integrate", "context_update", "release_ledger", "release_agent", "task.completed"]);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.completion, "coder_verified");
  assert.equal(events[0].payload.artifact_id, "ARTIFACT-1");
});

// Keeps a failed report tool from being interpreted as a successful Coder completion.
test("failed report_done cannot complete or request Human Review", async () => {
  const { workspace, actions } = workspaceWithReport("verified");
  await assert.rejects(completeCoderTicket({ workspace, result: { tool_events: [{ tool: "report_done", status: "failed" }] } }), { code: "AGENT_REPORT_MISSING" });
  assert.deepEqual(actions, []);
});
