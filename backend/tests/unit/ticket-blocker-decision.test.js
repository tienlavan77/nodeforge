// Verifies owner blocker decisions record the chosen proposal option and retain the parked ticket for AM fulfillment.
import assert from "node:assert/strict";
import test from "node:test";
import { createTicketBlockerDecisionService } from "../../src/application/ticket-blocker-decision-service.js";
import { createEventPublisher } from "../../src/modules/events/event-publisher.js";

const PROPOSAL = { title: "Lifecycle transport contract", options: [
  { id: "owner_approve_transport_contract", description: "Approve the transport contract" },
  { id: "approved_split", description: "Split foundation from transport" }
], recommended_option_id: "approved_split" };

function build({ status = "needs_human_review", version = 3, savedRecovery = null } = {}) {
  const recovery = savedRecovery ?? { job_id: "JOB-1", status: "owner_required", proposal: PROPOSAL, escalation: { boundary: "owner_scope", rationale: "Transport contract is owner scope." } };
  const checkpoint = { task_id: "TASK", status: "blocked", failure: { code: "CODER_BLOCKED", at: "FAIL-1" }, blocker_recovery: recovery };
  const state = { checkpoint: structuredClone(checkpoint), status: { project_id: "P", ticket_id: "TASK", status, version, details: { execution_id: "EXEC-1" } }, published: [] };
  const publisher = createEventPublisher({ store: { append: (event) => { state.published.push(event); return { accepted: true, event }; } } });
  const service = createTicketBlockerDecisionService({ projectId: "P",
    ticketStatusStore: { get: (ticketId) => ticketId === "TASK" ? state.status : undefined, updateStatus: (ticketId, next, details, guards) => {
      assert.equal(ticketId, "TASK"); assert.equal(next, "needs_human_review");
      assert.equal(guards.expectedCurrentStatus, "needs_human_review"); assert.equal(guards.expectedVersion, version);
      state.status = { ...state.status, status: next, version: version + 1, details };
      return state.status;
    } },
    checkpoints: { load: async () => state.checkpoint, save: async (record) => { state.checkpoint = record; return record; } },
    publisher, projectLogger: (entry) => { if (entry?.level === "error") throw new Error(entry.message); } });
  return { service, state };
}

test("records the chosen option, persists it in the checkpoint and retains the parked ticket", async () => {
  const { service, state } = build();
  const result = await service.decide({ requestedProjectId: "P", ticketId: "TASK", actor: "project_owner", reason: "Foundation trước, transport quyết sau.", optionId: "approved_split" });
  assert.equal(result.status, "needs_human_review");
  assert.equal(result.decision.option_id, "approved_split");
  assert.equal(result.decision.job_id, "JOB-1");
  assert.match(result.decision.decision_id, /^BLOCKER-DECISION-/);
  assert.equal(state.checkpoint.blocker_recovery.owner_decision.option_id, "approved_split");
  assert.deepEqual(state.checkpoint.blocker_owner_decisions, [result.decision]);
  assert.equal(state.status.status, "needs_human_review");
  assert.equal(state.status.details.reason, "owner_blocker_decision");
  assert.equal(state.status.details.owner_decision.option_id, "approved_split");
  assert.equal(state.published[0].event_type, "ticket.updated");
  assert.equal(state.published[0].payload.ticket_id, "TASK");
  assert.equal(state.published[0].payload.option_id, "approved_split");
});

test("an owner direction preserves the blocked failure until AM fulfills the handoff", async () => {
  const decided = build();
  await decided.service.decide({ requestedProjectId: "P", ticketId: "TASK", actor: "project_owner", optionId: "approved_split" });
  assert.equal(decided.state.checkpoint.status, "blocked");
  assert.equal(decided.state.checkpoint.phase, "owner_decided");
  assert.equal(decided.state.checkpoint.blocker_recovery.status, "owner_decided");
  assert.deepEqual(decided.state.checkpoint.stage_progress.map((entry) => [entry.stage, entry.status]), [["owner_decision", "decided"]]);
  assert.equal(decided.state.checkpoint.failure.at, "FAIL-1");
});

test("rejects unknown options, missing proposals, wrong project and duplicate decisions", async () => {
  const { service } = build();
  await assert.rejects(service.decide({ requestedProjectId: "P", ticketId: "TASK", actor: "owner", optionId: "nope" }), (error) => error.code === "BLOCKER_DECISION_OPTION_INVALID");
  await assert.rejects(service.decide({ requestedProjectId: "OTHER", ticketId: "TASK", actor: "owner", optionId: "approved_split" }), (error) => error.code === "PROJECT_CONTEXT_CONFLICT");
  await assert.rejects(service.decide({ requestedProjectId: "P", ticketId: "MISSING", actor: "owner", optionId: "approved_split" }), (error) => error.code === "TICKET_NOT_FOUND");
  await assert.rejects(service.decide({ requestedProjectId: "P", ticketId: "TASK", optionId: "approved_split" }), (error) => error.code === "BLOCKER_DECISION_INPUT");
  const decided = build({ savedRecovery: { job_id: "JOB-1", status: "owner_required", proposal: PROPOSAL, owner_decision: { decision_id: "BLOCKER-DECISION-1", option_id: "approved_split" } } });
  await assert.rejects(decided.service.decide({ requestedProjectId: "P", ticketId: "TASK", actor: "owner", optionId: "approved_split" }), (error) => error.code === "BLOCKER_DECISION_RECORDED");
  const pending = build(); pending.state.checkpoint.blocker_recovery.status = "pending";
  await assert.rejects(pending.service.decide({ requestedProjectId: "P", ticketId: "TASK", actor: "owner", optionId: "approved_split" }), (error) => error.code === "BLOCKER_DECISION_UNAVAILABLE");
});
