// Checks legacy review-blocker intake uses exact execution receipts and retains AM terms without guessing approval.
import assert from "node:assert/strict";
import test from "node:test";
import { restoreRepairBlocker, retainPriorBlockerContracts } from "../../src/modules/supervisor/blocker-repair-recovery.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

test("legacy blocked repair restores structured triage only for the current retained invocation", async () => {
  const checkpoint = { task_id: "TASK", status: "blocked", correlation_id: "CORR", last_completed_turn: 22, thread_id: "THREAD",
    review_findings: [{ finding_id: "REV-1" }], failure: { code: "CODER_BLOCKED", at: "2026-10-20T07:38:34.000Z" } };
  const current = { project_id: "P", details: { execution_id: "EXEC", execution_basis: { version: 1 } } };
  const handoff = { task_id: "TASK", project_id: "P", request_id: "REPAIR", correlation_id: "CORR", created_at: "2026-10-20T07:30:00.000Z",
    payload: { execution_id: "EXEC", sprint_basis: { version: 1 } } };
  const event = { event_id: "EVENT", timestamp: "2026-10-20T07:38:24.000Z", project_id: "P", task_id: "TASK", correlation_id: "CORR", status: "failed",
    payload: { request_id: "REPAIR", tool: "report_done", error: { code: "CODER_BLOCKED" }, arguments: { status: "blocked",
      blocker: { reason_code: "CONTRACT_DECISION_REQUIRED", owner_action: "Clarify legacy attribution." }, evidence: ["logger.js:118"] } } };
  const options = { checkpoint, current, projectRoot: process.cwd(), store: { list: async () => [handoff] },
    readEvents: async () => ({ events: [event] }) };
  const restored = await restoreRepairBlocker(options);
  assert.equal(restored.triage.reason_code, "CONTRACT_DECISION_REQUIRED");
  assert.equal(restored.failure_request_id, "REPAIR");
  assert.equal(restored.thread_id, "THREAD");
  assert.equal(restored.last_completed_turn, 22);
  assert.deepEqual(restored.review_findings, checkpoint.review_findings);
  for (const altered of [{ ...event, project_id: "OTHER" }, { ...event, timestamp: "2026-10-20T08:00:00Z" },
    { ...event, payload: { ...event.payload, request_id: "OLD" } }]) {
    assert.equal(await restoreRepairBlocker({ ...options, readEvents: async () => ({ events: [altered] }) }), checkpoint);
  }
  assert.equal(await restoreRepairBlocker({ ...options, current: { ...current, details: { ...current.details, execution_id: "OTHER" } } }), checkpoint);
});

test("new repair recovery retains prior AM contracts only from the same execution and Sprint", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const current = { project_id: "P", details: { execution_id: "EXEC", execution_basis: { version: 1 } } };
    const job = { id: "JOB", request: { task_id: "TASK", project_id: "P", payload: { execution_id: "EXEC", sprint_basis: { version: 1 } } },
      history: [{ stage: "architecture_manager", completed_at: 1000, disposition: { action: "resolved", authority_scope: "architecture", guidance: "Preserve NULL." } }] };
    const store = { list: async () => [{ jobs: [job, { ...job, id: "FOREIGN", request: { ...job.request, project_id: "OTHER" } }] }] };
    const restored = await retainPriorBlockerContracts({ checkpoint: { task_id: "TASK" }, current, store, fileService: fixture.base.fileService });
    assert.equal(restored.contract_decisions.length, 1);
    assert.equal(restored.contract_decisions[0].record.job_id, "JOB");
    assert.equal(restored.contract_decisions[0].record.actor, null);
  } finally { await fixture.close(); }
});
