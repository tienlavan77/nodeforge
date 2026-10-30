/** Exercises ticket completion when concurrent integration has already committed
 * the ticket bytes. Real Git and production storage prove no duplicate commit,
 * unrelated staging, stale verification, or lost recovery checkpoint is needed. */
import assert from "node:assert/strict";
import test from "node:test";
import { ticketRestoredCommitFixture } from "../fixtures/ticket-restored-commit-fixture.js";
import { createTicketReportCommit } from "../../src/tools/reporting/ticket-report-commit.js";
import { createTicketVerificationService } from "../../src/modules/supervisor/ticket/ticket-verification-service.js";
import { createProtocolStorage } from "../../src/infrastructure/storage/protocol-storage.js";
import { createCompletionReportService } from "../../src/modules/supervisor/completion-report-service.js";
import { createReportDoneTool } from "../../src/tools/reporting/agent-report-tool.js";
import { assertTicketExecutionCompleted, collectToolCalls, sdkToolEvent } from "../../src/modules/supervisor/nodeforge-task-sdk-events.js";

// Models an existing ticket repair whose exact bytes have already reached shared Git history.
async function integratedRepair(f) {
  await f.ledger.write({ taskId: f.taskId, path: "a.js", before: "ticket\n", after: "integrated repair\n" });
  await f.git("add", "a.js");
  await f.git("commit", "-qm", "concurrent integration");
  await f.executionContexts.syncManifest(f.taskId, await f.ledger.load(f.taskId));
  return (await f.git("rev-parse", "HEAD")).trim();
}

test("ticket commit references integrated bytes without a duplicate commit or unrelated staging", async (t) => {
  const f = await ticketRestoredCommitFixture(t);
  const commit = await integratedRepair(f);
  await f.files.atomicWrite({ path: "b.js", content: "unrelated staged edit\n", replace: true });
  await f.git("add", "b.js");
  const index = await f.git("diff", "--cached");
  const original = await f.files.readFile({ path: f.journalPath(1) });
  const result = await f.service().commit("report repair already integrated");
  assert.equal(result.sha, commit); assert.equal(result.inherited, true);
  assert.equal((await f.git("rev-list", "--count", "HEAD")).trim(), "3");
  assert.equal(await f.git("diff", "--cached"), index);
  assert.equal(await f.files.readFile({ path: f.journalPath(1) }), original);
  const journal = JSON.parse(await f.files.readFile({ path: f.journalPath(2) }));
  assert.equal(journal.reconciliation, "inherited_source");
  assert.equal(journal.reconciled_from_commit_sha, f.committed.sha);
  assert.equal(journal.transaction_id, undefined);
  assert.equal((await f.service().commit("retry")).sha, commit);
});

test("report reconciles integrated repair but invalidates historical verification and keeps normal checks", async (t) => {
  const f = await ticketRestoredCommitFixture(t);
  const commit = await integratedRepair(f);
  const reconcile = createTicketReportCommit({ gitService: f.service(), changeLedger: f.changeLedger, executionContexts: f.executionContexts });
  const context = { task_id: f.taskId, project_id: f.projectId, ticket: { id: f.taskId }, capabilities: ["report_done"] };
  const result = await reconcile(context);
  assert.equal(result.sha, commit);
  const current = await f.executionContexts.load(f.taskId);
  assert.equal(current.review_commit_sha, commit); assert.equal(current.state, "committed");
  assert.equal(current.verification_artifact_id, null); assert.equal(current.verification_source, null);
  assert.notEqual(current.source_revision, f.saved.source_revision);
});

test("integrated source reference recovers a journal-first crash and survives later unrelated commits", async (t) => {
  const f = await ticketRestoredCommitFixture(t);
  const commit = await integratedRepair(f);
  await f.service().reconcileRestoredCommit();
  const manifest = await f.ledger.load(f.taskId);
  delete manifest.commits[2];
  await f.files.atomicWrite({ path: f.manifestPath, content: JSON.stringify(manifest), replace: true });
  await f.files.atomicWrite({ path: "b.js", content: "later integration\n", replace: true });
  await f.git("add", "b.js"); await f.git("commit", "-qm", "later integration");
  assert.equal((await f.service().commit("restart")).sha, commit);
  assert.equal((await f.ledger.load(f.taskId)).commits[2], commit);
});

test("further diagnostic round trips and real edits work after an inherited source reference", async (t) => {
  const f = await ticketRestoredCommitFixture(t);
  const commit = await integratedRepair(f);
  await f.service().commit("integrated");
  await f.ledger.write({ taskId: f.taskId, path: "a.js", before: "integrated repair\n", after: "diagnostic\n" });
  assert.equal(await f.service().reconcileRestoredCommit(), null);
  await f.ledger.write({ taskId: f.taskId, path: "a.js", before: "diagnostic\n", after: "integrated repair\n" });
  assert.equal((await f.service().commit("restored integrated")).sha, commit);
  await f.ledger.write({ taskId: f.taskId, path: "a.js", before: "integrated repair\n", after: "next real repair\n" });
  assert.notEqual((await f.service().commit("next repair")).sha, commit);
});

test("an integrated changed path cannot conceal an uncommitted unchanged ticket path", async (t) => {
  const f = await ticketRestoredCommitFixture(t);
  await f.ledger.write({ taskId: f.taskId, path: "b.js", before: "unrelated\n", after: "pending ticket file\n" });
  await f.service().commit("own second path");
  await f.git("add", "b.js");
  await integratedRepair(f);
  await f.files.atomicWrite({ path: "b.js", content: "external dirty bytes\n", replace: true });
  await assert.rejects(f.service().reconcileRestoredCommit(), { code: "TICKET_SOURCE_DRIFT" });
});

test("inherited references reject foreign claims and corrupted provenance without manufacturing commits", async (t) => {
  const f = await ticketRestoredCommitFixture(t);
  await integratedRepair(f);
  const original = JSON.parse(await f.files.readFile({ path: f.journalPath(1) }));
  await f.files.atomicWrite({ path: f.journalPath(1), content: JSON.stringify({ ...original, transaction_id: "wrong" }), replace: true });
  await assert.rejects(f.service().reconcileRestoredCommit(), { code: "TICKET_COMMIT_RECOVERY_CONFLICT" });
  await f.files.atomicWrite({ path: f.journalPath(1), content: JSON.stringify(original), replace: true });
  await f.ledger.release(f.taskId, { close: false });
  await f.ledger.write({ taskId: "OTHER", path: "a.js", before: "integrated repair\n", after: "integrated repair\n" });
  await assert.rejects(f.service().reconcileRestoredCommit(), { code: "FILE_CLAIM_CONFLICT" });
  assert.equal((await f.ledger.load(f.taskId)).commits[2], undefined);
});

test("verification and review diff use inherited ticket scope rather than unrelated snapshot commit paths", async (t) => {
  const f = await ticketRestoredCommitFixture(t);
  await integratedRepair(f);
  await f.files.atomicWrite({ path: "b.js", content: "other ticket integration\n", replace: true });
  await f.git("add", "b.js"); await f.git("commit", "-qm", "unrelated latest commit");
  const commit = (await f.git("rev-parse", "HEAD")).trim();
  const gitService = f.service();
  await createTicketReportCommit({ gitService, changeLedger: f.changeLedger, executionContexts: f.executionContexts })({
    task_id: f.taskId, project_id: f.projectId, ticket: { id: f.taskId }, capabilities: ["report_done"] });
  assert.deepEqual(await gitService.getVerificationPaths(commit), ["a.js"]);
  const patch = await gitService.diffPatchFrom(f.saved.base_sha, { paths: ["a.js"] });
  assert.match(patch, /integrated repair/); assert.doesNotMatch(patch, /other ticket integration/);
  assert.equal((await gitService.getCommitsForTask(f.taskId)).at(-1).source_reference, "inherited");
  const verification = createTicketVerificationService({ taskId: f.taskId, projectId: f.projectId, projectRoot: f.root,
    worktreeRoot: f.root, worktreeFileService: f.files, stateFileService: f.files, gitService, ledger: f.ledger,
    executionContexts: f.executionContexts, rootOnly: true, runCommand: async () => ({ exit_code: 0, stdout: "test fixture\n", stderr: "" }) });
  const job = await verification.startTests();
  let result;
  do { result = await verification.getTestResult({ jobId: job.job_id }); if (result.status === "running") await new Promise((resolve) => setTimeout(resolve, 20)); } while (result.status === "running");
  assert.equal(result.status, "passed", JSON.stringify(result));
  const artifact = await verification.assertPassedArtifact();
  assert.deepEqual(artifact.changed_paths, ["a.js"]); assert.equal(artifact.commit_sha, commit);
  const protocolStorage = createProtocolStorage({ projectRoot: f.root, fileService: f.files });
  const reportService = createCompletionReportService({ protocolStorage, fileService: f.files, gitService });
  const ticket = { id: f.taskId, title: "Retained repair", objective: "Complete the verified repair", acceptance_criteria: ["Syntax checks pass"] };
  const report = await createReportDoneTool({ reportService, verificationService: verification }).execute({ summary: "Verified inherited repair.",
    acceptance_coverage: [{ criterion_id: "AC-1", status: "verified", command_kind: "typecheck" }] }, { ticket });
  const codex = sdkToolEvent({ type: "item.completed", item: { type: "mcp_tool_call", server: "forge", name: "report_done", status: "completed", result: report } });
  const claude = collectToolCalls([{ content: [{ type: "tool_use", id: "report", name: "mcp__forge__report_done" }] },
    { content: [{ type: "tool_result", tool_use_id: "report", content: report.content }] }]);
  for (const events of [[codex], claude]) assert.doesNotThrow(() => assertTicketExecutionCompleted(events, { priorTools: ["edit_diff", "run_check"] }));
  const submitted = await reportService.assertCoderReport(f.taskId);
  assert.equal(submitted.status, "submitted_for_review");
  assert.equal(submitted.verify_result.artifact_id, artifact.artifact_id);
  assert.equal((await f.executionContexts.load(f.taskId)).state, "verified");
  assert.equal((await f.git("rev-parse", "HEAD")).trim(), commit);
});
