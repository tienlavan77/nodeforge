// Verifies a report saved after SDK timeout resumes review without restarting Coder or erasing accepted evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";

// Recreates the durable late-report state using narrow in-memory boundaries rather than launching providers or verification.
function fixture({ pendingEvidence = false, cancelled = false } = {}) {
  const projectId = "PROJECT-A";
  const ticket = { id: "TICKET-A", project_id: projectId, sprint_id: "SPRINT-A", title: "Lifecycle", objective: "Complete lifecycle", acceptance_criteria: ["Lifecycle works"], dependencies: [] };
  const checkpoint = { status: "completed", phase: "blocker_resolved", agent_id: "CODER", provider: "codex",
    last_completed_turn: 67, completed_tools: ["write_diff", "commit_changes", "report_done"], failure: { code: "REPORT_FAILED" } };
  const report = { status: "submitted_for_review", criteria_check: [{ criterion_id: "AC-1", status: pendingEvidence ? "evidence_pending" : "verified" }] };
  let current = { project_id: projectId, status: "pending", details: { reason: "ticket_failed_retry_ready" } };
  const calls = [];
  const cleared = [];
  const dispatch = createTicketRunDispatch({
    disposition: { get: async () => cancelled ? { disposition: "cancelled" } : null },
    intake: { open: async () => ({ ticket }) },
    sprintRegistry: { get: () => ({ status: "ready" }), assertReady: async () => ({ plan: { content: { tickets: [ticket.id], ticket_specs: [ticket] } } }) },
    ticketStatusStore: { get: () => current, updateStatus: (_taskId, status, details) => { current = { ...current, status, details }; return current; } },
    checkpoints: { load: async () => checkpoint, loadReview: async () => null, clear: async () => cleared.push("checkpoint") },
    queueStore: { list: async () => [] },
    protocolStorage: { get: async () => ({ data: report }), clearTask: async () => cleared.push("report") },
    conversationStateStore: { clear: async () => cleared.push("conversation") },
    dispatchTask: async (request) => { calls.push(request); return { status: "accepted" }; }
  });
  return { run: () => dispatch({ projectId, ticketId: ticket.id }), calls, cleared, checkpoint, report };
}

test("a late verified report resumes the Reviewer phase without a fresh Coder request", async () => {
  const context = fixture();
  const before = structuredClone({ checkpoint: context.checkpoint, report: context.report });
  const result = await context.run();
  assert.equal(result.resumed, true);
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].review_resume.agent_id, "CODER");
  assert.equal(context.calls[0].resume_from, undefined);
  assert.equal(context.calls[0].review_resume.review_attempt, 0);
  assert.deepEqual(context.cleared, []);
  assert.deepEqual({ checkpoint: context.checkpoint, report: context.report }, before);
});

test("a saved report with missing AC evidence cannot bypass Coder evidence recovery into Reviewer", async () => {
  const context = fixture({ pendingEvidence: true });
  await context.run();
  assert.equal(context.calls[0].review_resume, undefined);
  assert.equal(context.calls[0].resume_from.phase, "coder_evidence_required");
  assert.deepEqual(context.calls[0].resume_from.pending_criterion_ids, ["AC-1"]);
  assert(!context.calls[0].resume_from.completed_tools.includes("report_done"));
  assert.deepEqual(context.cleared, []);
});

test("Owner cancellation still prevents late report resume", async () => {
  const context = fixture({ cancelled: true });
  await assert.rejects(context.run(), { code: "TICKET_CANCELLED" });
  assert.deepEqual(context.calls, []);
  assert.deepEqual(context.cleared, []);
});
