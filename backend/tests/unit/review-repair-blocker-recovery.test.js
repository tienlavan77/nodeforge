// Verifies finding repairs retain AM evidence and send structured blockers to the normal recovery handler.
import assert from "node:assert/strict";
import test from "node:test";
import { currentReviewFindings } from "../../src/modules/supervisor/review-query-records.js";
import { createTicketReviewRepair } from "../../src/modules/supervisor/ticket-review-repair.js";
import { completeCoderTicket } from "../../src/modules/supervisor/ticket-coder-completion.js";
import { handleTicketExecutionFailure } from "../../src/modules/supervisor/ticket-execution-failure.js";

// Keeps the Coder's latest session and completed edits when Node corrects an acknowledgement-only repair.
test("implementation correction continues the current Coder checkpoint without rotating its journal again", async () => {
  let checkpoint = { task_id: "TASK", status: "completed", phase: "finding_repair_ready", review_repair_key: "REVIEW",
    last_completed_turn: 17, thread_id: "THREAD", changed_paths: ["source.js"], completed_tools: ["read_lines", "edit_diff"],
    contract_decisions: [{ path: "contract" }], blocker_recovery: { status: "resolved", disposition: { guidance: "Old delivery only" } } };
  let rotations = 0;
  const repair = createTicketReviewRepair({ taskId: "TASK", ownerId: "SUP", ticket: { id: "TASK" },
    selected: { agent_id: "CODER", provider: "codex" }, checkpoints: { load: async () => checkpoint,
      save: async (value) => { checkpoint = value; }, saveReview: async () => {}, complete: async () => {} },
    workspace: { beginFindingRepair: async () => { rotations++; } }, handoffQueue: { enqueue: async () => ({ id: "JOB" }) },
    execute: async (request) => {
      const resume = request.payload.resume_from;
      assert.equal(resume.last_completed_turn, 17);
      assert.equal(resume.thread_id, "THREAD");
      assert.deepEqual(resume.changed_paths, ["source.js"]);
      assert.deepEqual(resume.completed_tools, ["read_lines", "edit_diff"]);
      assert.equal(resume.blocker_recovery.status, "superseded_by_review");
      assert.equal(resume.repair_implementation_required.instruction, "Implement the accepted defect");
      return { tool_events: [{ tool: "report_done", status: "success" }] };
    } });
  await repair({ request: { task_id: "TASK", project_id: "P", request_id: "REQ", payload: {} }, findings: [{ finding_id: "REV-1" }],
    outcome: { payload: { job_key: "REVIEW", repair_implementation_required: { instruction: "Implement the accepted defect" } } } });
  assert.equal(rotations, 0);
});

test("repair blocker escapes review parking with the actual repair request and latest checkpoint intact", async () => {
  const decisions = [{ path: "receipt", sha256: "a".repeat(64) }];
  let checkpoint = { task_id: "TASK", status: "completed", contract_decisions: decisions, blocker_recovery: { status: "resolved" } };
  const checkpoints = { load: async () => checkpoint, save: async (value) => { checkpoint = value; }, saveReview: async () => {} };
  const findings = [{ finding_id: "REV-1", message: "Preserve legacy NULL attribution." }];
  const blocked = Object.assign(new Error("Contract clarification required"), { code: "CODER_BLOCKED", details: {
    blocker: { reason_code: "CONTRACT_DECISION_REQUIRED", owner_action: "Clarify the persisted legacy log contract." }, evidence: ["log-service.js:118"] } });
  const request = { task_id: "TASK", project_id: "P", request_id: "REQ", supervisor_id: "SUP", attempt: 1,
    ticket: { id: "TASK", execution_policy: { review_gate: "on" } }, payload: { execution_id: "EXEC" } };
  const runRepair = createTicketReviewRepair({ taskId: "TASK", ownerId: "SUP", ticket: request.ticket, selected: { agent_id: "CODER", provider: "codex" },
    checkpoints, workspace: {}, handoffQueue: { enqueue: async () => ({ id: "JOB" }) }, execute: async (repair) => {
      assert.deepEqual(repair.payload.resume_from.contract_decisions, decisions);
      assert.deepEqual(repair.payload.resume_from.review_findings, currentReviewFindings(findings));
      checkpoint = { ...checkpoint, status: "blocked", last_completed_turn: 22, thread_id: "THREAD", changed_paths: ["runtime-logger.js"] };
      throw blocked;
    } });
  let parked = 0;
  const workspace = { executionContexts: { load: async () => ({ manifest_paths: ["runtime-logger.js"] }) },
    testService: { assertPassedArtifact: async () => ({ artifact_id: "ART" }) }, reportService: { assertCoderReport: async () => {} },
    reviewFindings: { unresolved: async () => findings } };
  const reviewJob = { job_key: "REVIEW", review_policy: { gate: "on" } };
  await assert.rejects(completeCoderTicket({ workspace, taskId: "TASK", ownerId: "SUP", request, runRepair,
    claim: { claim_id: "CLAIM" }, result: { tool_events: [{ tool: "report_done", status: "success" }] },
    automaticReview: { prepare: async () => reviewJob, process: async () => ({ payload: { verdict: "request_changes", findings } }),
      consumeRepair: async () => true, park: async () => { parked += 1; } }
  }), (error) => error === blocked && error.failed_request.request_id === "REQ-REPAIR-1");
  assert.equal(parked, 0);
  const events = [];
  await handleTicketExecutionFailure({ error: blocked, failedRequest: blocked.failed_request, checkpoints, taskId: "TASK", ownerId: "SUP",
    claim: { claim_id: "CLAIM" }, agentOccupancy: { release: async () => {} }, projectLogger: () => {},
    publishTicketOutcome: async (type, failed, _owner, payload) => events.push({ type, request_id: failed.request_id, payload }) });
  assert.equal(checkpoint.triage.reason_code, "CONTRACT_DECISION_REQUIRED");
  assert.equal(checkpoint.failure_request_id, "REQ-REPAIR-1");
  assert.equal(checkpoint.last_completed_turn, 22);
  assert.equal(checkpoint.thread_id, "THREAD");
  assert.deepEqual(checkpoint.contract_decisions, decisions);
  assert.deepEqual(checkpoint.review_findings, currentReviewFindings(findings));
  assert.equal(events[0].type, "task.needs_human_review");
  assert.equal(events[0].payload.reason, "CODER_BLOCKED");
});
