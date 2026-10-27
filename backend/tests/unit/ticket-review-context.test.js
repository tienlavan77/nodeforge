// Verifies Reviewer resume preserves passed evidence without restarting mutable Coder preparation.
import assert from "node:assert/strict";
import test from "node:test";
import { prepareTicketReviewContext } from "../../src/modules/supervisor/ticket-review-context.js";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";
import { reviewPhaseResume } from "../../src/modules/supervisor/review-revision-resume.js";

// Provides fixed passed evidence and rejects any attempted Coder source refresh.
function fixture() {
  const context = { task_id: "TICKET-1", project_id: "PROJECT-1", supervisor_id: "SUP-1", base_sha: "a".repeat(40),
    state: "reviewing", review_commit_sha: "b".repeat(40), verification_artifact_id: "ARTIFACT-1", source_revision: "source-1", manifest_sha: "manifest-1", verification_plan: [] };
  const artifact = { status: "passed", artifact_id: context.verification_artifact_id, commit_sha: context.review_commit_sha,
    base_sha: context.base_sha, source_revision: context.source_revision, manifest_sha: context.manifest_sha };
  const calls = [];
  // Fails if independent review tries to mutate or adopt the live source journal.
  const rejectCoder = async () => { throw new Error("Unexpected Coder preparation"); };
  const workspace = { root_only: true, projectRoot: process.cwd(), base_commit: context.base_sha,
    executionContexts: { load: async () => context, create: rejectCoder, syncManifest: rejectCoder,
      update: async (_task, _version, patch) => Object.assign(context, patch) },
    changeLedger: { snapshot: rejectCoder, resume: rejectCoder, release: async () => { calls.push("release"); } },
    testService: { assertPassedArtifact: async () => artifact }, reportService: { assertCoderReport: async () => {}, completeAcceptedReport: async () => { calls.push("accepted"); } },
    integrate: async () => { calls.push("integrated"); } };
  const ticket = { id: context.task_id, project_id: context.project_id, verification_plan: [], acceptance_criteria: ["Works"], execution_policy: { requires_existing_contract: true } };
  const resume = { agent_id: "CODER-1", provider: "codex", base_commit: context.base_sha, verification: structuredClone(artifact) };
  return { context, artifact, workspace, ticket, resume, calls, rejectCoder, options: { workspace, ticket, resume, taskId: context.task_id, supervisorId: context.supervisor_id } };
}

test("review context keeps the persisted passed identity without inspecting live Coder source", async () => {
  const f = fixture();
  assert.equal(await prepareTicketReviewContext(f.options), f.context);
});

test("completed Coder repair resumes review on its new artifact rather than the previous request_changes artifact", async () => {
  const f = fixture();
  const coder = { status: "completed", agent_id: "CODER-1", provider: "codex", attempt: 3, execution_context: f.context };
  const previous = { status: "completed", verdict: "request_changes", attempt: 3, review_attempt: 2, base_commit: "c".repeat(40),
    verification: { ...f.artifact, artifact_id: "ARTIFACT-OLDER", commit_sha: "d".repeat(40), source_revision: "source-older" } };
  f.options.resume = reviewPhaseResume(coder, previous);
  assert.equal(f.options.resume.verification.artifact_id, f.artifact.artifact_id);
  assert.equal(f.options.resume.base_commit, f.context.base_sha);
  assert.equal(f.options.resume.review_attempt, 3);
  assert.equal(await prepareTicketReviewContext(f.options), f.context);
  const same = reviewPhaseResume(coder, { ...previous, verdict: null, verification: f.artifact, base_commit: f.context.base_sha });
  assert.equal(same.verification, f.artifact); assert.equal(same.review_attempt, 2);
});

test("repair completion with a pre-verification checkpoint loads its current artifact from the authoritative store", async () => {
  const f = fixture();
  const coder = { status: "completed", agent_id: "CODER-1", provider: "codex", attempt: 3,
    execution_context: { ...f.context, state: "coding", verification_artifact_id: null, review_commit_sha: null } };
  const previous = { verdict: "request_changes", attempt: 2, verification: { ...f.artifact, artifact_id: "ARTIFACT-OLDER" }, base_commit: f.context.base_sha };
  f.options.resume = reviewPhaseResume(coder, previous);
  assert.equal(f.options.resume.verification, null);
  assert.equal(await prepareTicketReviewContext(f.options), f.context);
  f.artifact.status = "failed";
  await assert.rejects(prepareTicketReviewContext(f.options), { code: "REVIEW_EVIDENCE_MISMATCH" });
});

test("review context rejects changed ownership, plan, state, artifact, and stale checkpoint evidence", async () => {
  for (const change of [
    (f) => { f.context.project_id = "FOREIGN"; }, (f) => { f.context.supervisor_id = "FOREIGN"; },
    (f) => { f.context.state = "coding"; }, (f) => { f.context.state = "terminal"; },
    (f) => { f.context.verification_plan = [{ kind: "test", test_path: "changed.test.js" }]; },
    (f) => { f.artifact.manifest_sha = "changed"; }, (f) => { f.artifact.status = "failed"; },
    (f) => { f.resume.verification.commit_sha = "c".repeat(40); }, (f) => { f.resume.base_commit = "c".repeat(40); }
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(prepareTicketReviewContext(f.options), { code: "REVIEW_EVIDENCE_MISMATCH" });
  }
  const f = fixture();
  f.workspace.testService.assertPassedArtifact = async () => { throw Object.assign(new Error("Ledger changed"), { code: "VERIFY_SOURCE_STALE" }); };
  await assert.rejects(prepareTicketReviewContext(f.options), { code: "VERIFY_SOURCE_STALE" });
});

test("ticket submission resumes Reviewer through integration without Coder preflight, file claims, or handoff preparation", async () => {
  const f = fixture();
  const coder = { agent_id: "CODER-1", provider: "codex", enabled: true, role: "coder" };
  const job = { job_key: "review-1", review_policy: { gate: "on" } };
  const integration = createNodeforgeTaskIntegration({ projectRoot: process.cwd(),
    supervisorManager: { startTask: f.rejectCoder, getByTask: () => ({ supervisorId: "SUP-1" }) }, eventBus: { publish: async () => {} },
    handoffQueue: { enqueue: f.rejectCoder }, agentResolver: { resolveAvailable: f.rejectCoder, list: () => [coder] },
    agentOccupancy: { getByTask: () => null, claim: async () => ({ claim_id: "CLAIM-1" }), release: async () => {} },
    resolveTicketWorkspace: async () => f.workspace, blockerRecovery: { preflight: f.rejectCoder },
    automaticReview: { prepare: async () => job, process: async () => { f.calls.push("reviewer"); return { payload: { verdict: "approved" } }; },
      assertApproval: async () => {}, recordCompletion: async () => {}, publishCompletion: async () => {} },
    codexSdkGateway: { execute: f.rejectCoder }
  });
  const result = await integration.submitTicket({ ticket: f.ticket, payload: { review_resume: f.resume } });
  assert.equal(result.status, "completed");
  assert.deepEqual(f.calls, ["reviewer", "integrated", "accepted", "release"]);
  assert.equal(f.context.state, "terminal");
});
