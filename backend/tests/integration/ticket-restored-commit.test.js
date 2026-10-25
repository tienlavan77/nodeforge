/** Proves reverted diagnostic edits can reuse a real same-ticket commit while
 * retaining source checks, claims, crash recovery, checkpoint continuity and
 * independent verification. Other ticket changes never need a duplicate commit. */
import assert from "node:assert/strict";
import test from "node:test";
import { ticketRestoredCommitFixture } from "../fixtures/ticket-restored-commit-fixture.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";
import { createTicketReportCommit } from "../../src/tools/ticket-report-commit.js";
import { checkpointedRegistry, createResumeState } from "../../src/modules/supervisor/ticket-resume.js";

test("restored ticket reuses its commit after restart and unrelated HEAD changes, preserving original receipts", async (t) => {
  const f = await ticketRestoredCommitFixture(t);
  const original = await f.files.readFile({ path: f.journalPath(1) });
  await f.restore();
  await f.files.atomicWrite({ path: "b.js", content: "other ticket\n", replace: true });
  await f.git("add", "b.js"); await f.git("commit", "-qm", "other ticket");
  await f.files.atomicWrite({ path: "b.js", content: "unrelated uncommitted\n", replace: true });
  const head = await f.git("rev-parse", "HEAD"), index = await f.git("diff", "--cached");
  const result = await f.service().reconcileRestoredCommit();
  assert.equal(result.sha, f.committed.sha); assert.equal(result.restored, true);
  const manifest = await f.ledger.load(f.taskId);
  assert.equal(manifest.revision, 3); assert.equal(manifest.entries["a.js"].operations.length, 3);
  assert.deepEqual(manifest.commits, { 1: f.committed.sha, 3: f.committed.sha });
  assert.equal(await f.files.readFile({ path: f.journalPath(1) }), original);
  assert.equal(await f.git("rev-parse", "HEAD"), head); assert.equal(await f.git("diff", "--cached"), index);
  assert.equal(await f.files.readFile({ path: "b.js" }), "unrelated uncommitted\n");
  assert.equal((await f.service().commit("retry unchanged ticket")).sha, f.committed.sha);
  assert.equal(f.logs.filter((event) => event.event_name === "ticket.restored_commit_reconciled").length, 1);
});

test("normal commit retry reconciles the restored source instead of producing an empty commit failure", async (t) => {
  const f = await ticketRestoredCommitFixture(t);
  await f.restore();
  assert.equal((await f.service().commit("save restored ticket")).sha, f.committed.sha);
  assert.equal((await f.git("rev-list", "--count", "HEAD")).trim(), "2");
  await f.ledger.write({ taskId: f.taskId, path: "a.js", before: "ticket\n", after: "real next repair\n" });
  assert.equal(await f.service().reconcileRestoredCommit(), null);
  const next = await f.service().commit("real repair");
  assert.notEqual(next.sha, f.committed.sha);
});

test("diagnostic file additions and deletions with no remaining change keep the retained commit", async (t) => {
  const f = await ticketRestoredCommitFixture(t);
  await f.restore();
  await f.ledger.write({ taskId: f.taskId, path: "temporary.js", before: null, after: "diagnostic\n" });
  assert.equal(await f.service().reconcileRestoredCommit(), null);
  await f.ledger.write({ taskId: f.taskId, path: "temporary.js", before: "diagnostic\n", after: null });
  assert.equal((await f.service().commit("retain restored source")).sha, f.committed.sha);
  const manifest = await f.ledger.load(f.taskId);
  assert.equal(manifest.commits[5], f.committed.sha);
  assert.equal(manifest.entries["temporary.js"].latest_sha, null);
  assert.equal((await f.service().commit("idempotent retry")).sha, f.committed.sha);
});

test("journal-first restoration recovers a crash before the ledger association is persisted", async (t) => {
  const f = await ticketRestoredCommitFixture(t);
  await f.restore(); await f.service().reconcileRestoredCommit();
  const manifest = await f.ledger.load(f.taskId);
  delete manifest.commits[3];
  await f.files.atomicWrite({ path: f.manifestPath, content: JSON.stringify(manifest), replace: true });
  assert.equal((await f.service().commit("recover retained association")).sha, f.committed.sha);
  assert.equal((await f.ledger.load(f.taskId)).commits[3], f.committed.sha);
  const journal = JSON.parse(await f.files.readFile({ path: f.journalPath(3) }));
  assert.equal(journal.reconciliation, "restored_source"); assert.equal(journal.reconciled_from_revision, 1);
  assert.equal((await f.git("rev-list", "--count", "HEAD")).trim(), "2");
});

test("restoration refuses foreign claims, source drift and invalid original receipt identity", async (t) => {
  const f = await ticketRestoredCommitFixture(t);
  await f.restore();
  await f.files.atomicWrite({ path: "a.js", content: "external edit\n", replace: true });
  await assert.rejects(f.service().reconcileRestoredCommit(), { code: "TICKET_SOURCE_DRIFT" });
  await f.files.atomicWrite({ path: "a.js", content: "ticket\n", replace: true });
  const original = JSON.parse(await f.files.readFile({ path: f.journalPath(1) }));
  await f.files.atomicWrite({ path: f.journalPath(1), content: JSON.stringify({ ...original, task_id: "OTHER" }), replace: true });
  await assert.rejects(f.service().reconcileRestoredCommit(), { code: "TICKET_COMMIT_RECOVERY_CONFLICT" });
  await f.files.atomicWrite({ path: f.journalPath(1), content: JSON.stringify(original), replace: true });
  await f.ledger.release(f.taskId, { close: false });
  await f.ledger.write({ taskId: "OTHER", path: "a.js", before: "ticket\n", after: "ticket\n" });
  await assert.rejects(f.service().reconcileRestoredCommit(), { code: "FILE_CLAIM_CONFLICT" });
  assert.equal((await f.ledger.load(f.taskId)).commits[3], undefined);
});

test("report authorization and scope are checked before a restored commit can be associated", async (t) => {
  const f = await ticketRestoredCommitFixture(t);
  await f.restore();
  const reconcile = createTicketReportCommit({ gitService: f.service(), changeLedger: f.changeLedger, executionContexts: f.executionContexts });
  const context = { task_id: f.taskId, project_id: f.projectId, ticket: { id: f.taskId }, capabilities: ["report_done"] };
  await assert.rejects(reconcile({ ...context, capabilities: [] }), { code: "TOOL_FORBIDDEN" });
  await assert.rejects(reconcile({ ...context, project_id: "OTHER" }), { code: "TICKET_COMMIT_SCOPE" });
  await assert.rejects(reconcile({ ...context, ticket: { id: "OTHER" } }), { code: "TICKET_COMMIT_SCOPE" });
  assert.equal((await f.ledger.load(f.taskId)).commits[3], undefined);
});

test("resumed report reaches normal verification through the real registry without faking a commit turn", async (t) => {
  const f = await ticketRestoredCommitFixture(t);
  await f.restore();
  let verified = 0;
  const registry = createForgeToolRegistry({ protocolStorage: { get: async () => null }, fileService: f.files, projectRoot: f.root,
    gitService: f.service(), changeLedger: f.changeLedger, executionContexts: f.executionContexts,
    testService: { assertPassedArtifact: async () => { verified++; throw Object.assign(new Error("Normal verification still required."), { code: "VERIFY_RECOVERY_PENDING" }); } },
    reportService: { buildFinalReport: async () => ({}), saveReport: async () => {}, writeReportFile: async () => {} } });
  const resume = { status: "blocked", last_completed_turn: 27, session_id: "SDK-RETAINED", changed_paths: ["a.js"],
    completed_tools: ["commit_changes", "edit_diff", "edit_diff"] };
  const state = createResumeState(resume);
  const wrapped = checkpointedRegistry({ store: { save: async () => {}, complete: async () => {} }, registry, taskId: f.taskId, resumeState: state });
  const context = { task_id: f.taskId, project_id: f.projectId, ticket: { id: f.taskId }, changed_paths: ["a.js"], capabilities: ["report_done"] };
  await assert.rejects(wrapped.report_done.execute({ status: "completed", summary: "Retained report." }, context), { code: "VERIFY_RECOVERY_PENDING" });
  assert.equal(verified, 1); assert.equal(state.turnCount, 27); assert.equal(state.sessionId, "SDK-RETAINED");
  assert.deepEqual(state.completedTools, resume.completed_tools);
  const current = await f.executionContexts.load(f.taskId);
  assert.equal(current.review_commit_sha, f.committed.sha); assert.equal(current.state, "committed");
  assert.equal(current.verification_artifact_id, null);
  assert.notEqual(current.source_revision, f.saved.source_revision);
  assert.equal((await f.git("rev-list", "--count", "HEAD")).trim(), "2");
  await f.ledger.write({ taskId: f.taskId, path: "a.js", before: "ticket\n", after: "new repair\n" });
  await assert.rejects(wrapped.report_done.execute({ status: "completed", summary: "Stale restored proof." }, context), { code: "COMMIT_MISSING" });
  assert.equal(verified, 1);
  assert.equal((await f.ledger.load(f.taskId)).commits[4], undefined);
});
