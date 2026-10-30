/** Proves a report suspended on Node verification enters independent review on
 * PASS without a second Coder request or returning passing command transcripts. */
import assert from "node:assert/strict";
import test from "node:test";
import { automaticReviewFixture } from "../fixtures/automatic-review-fixture.js";
import { createTicketVerificationRecovery } from "../../src/modules/supervisor/ticket/ticket-verification-recovery.js";
import { createReportDoneTool } from "../../src/tools/reporting/agent-report-tool.js";

test("Node verification PASS saves the pending Coder report and invokes Reviewer directly", async () => {
  const f = automaticReviewFixture();
  f.artifact.commands = [{ kind: "backend_tests", exit_code: 0, argv: ["node", "--test", "backend/tests/unit/ticket.test.js"], stdout_redacted: "PASS-NOISE" }];
  let passed = false, finishWaiting, saved;
  const waiting = new Promise(resolve => { finishWaiting = resolve; });
  const ensurePassedArtifact = createTicketVerificationRecovery({ taskId: f.request.task_id, pollMs: 1,
    executionContexts: { load: async () => ({ state: "committed", review_commit_sha: f.artifact.commit_sha }) },
    assertIdentity: async () => {}, assertPassedArtifact: async () => {
      if (!passed) throw Object.assign(new Error("Pending verification"), { code: "VERIFY_ARTIFACT_MISMATCH" });
      return f.artifact;
    }, startTests: async () => ({ job_id: "VERIFY-1", status: "running" }), getTestResult: async () => ({ status: passed ? "passed" : "running" }) });
  const report = createReportDoneTool({ verificationService: { ensurePassedArtifact }, reportService: {
    buildFinalReport: async input => input, saveReport: async (_id, value) => { saved = value; }, writeReportFile: async () => {} } });
  f.workspace.reportService.assertCoderReport = async () => { assert.equal(saved?.verifyResult?.artifact_id, f.artifact.artifact_id); };
  const work = (async () => {
    const response = await report.execute({ summary: "Implemented the ticket", acceptance_coverage: [{ criterion_id: "AC-1", command_kind: "backend_tests", test_path: "backend/tests/unit/ticket.test.js" }] },
      { ticket: f.request.ticket, onVerificationWaiting: finishWaiting });
    assert(!JSON.stringify(response).includes("PASS-NOISE"));
    return f.complete(() => assert.fail("Passing verification must not invoke Coder repair"));
  })();
  await waiting;
  assert.equal(f.calls, 0);
  assert.equal(saved, undefined);
  passed = true;
  const outcome = await work;
  assert.equal(outcome.status, "completed");
  assert.equal(f.calls, 1);
  assert(f.order.indexOf("review.approved") < f.order.indexOf("integrate"));
});
