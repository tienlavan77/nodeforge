// Exercises persisted context, a real Git ticket commit, command verification, and review evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentProfileStore } from "../../src/modules/agent/agent-profile-store.js";
import { createAgentOccupancyStore } from "../../src/modules/agent/agent-occupancy-store.js";
import { createCodeSearch } from "../../src/modules/index/code-search.js";
import { createFileGraph } from "../../src/modules/index/file-graph.js";
import { createTicketWorkspaceService } from "../../src/modules/supervisor/ticket-workspace-service.js";
import { prepareTicketExecutionContext } from "../../src/modules/supervisor/ticket-execution-context.js";
import { assertTicketReviewEvidence } from "../../src/modules/supervisor/ticket-review-evidence.js";
import { completeApprovedTicket } from "../../src/modules/supervisor/ticket-approved-integration.js";
import { createReviewWorker } from "../../src/modules/supervisor/review-worker.js";
import { inspectTicketProcess } from "./immutable-ticket-process-helper.js";

const execFile = promisify(execFileCallback);

// Runs Git directly only for disposable test fixture setup and assertions.
async function git(root, ...args) { return (await execFile("git", ["-C", root, ...args])).stdout.trim(); }

// Waits for a persisted verification result rather than an in-memory callback.
async function finished(service, jobId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await service.getTestResult({ jobId });
    if (job.status !== "running") return job;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("Ticket verification did not finish within six seconds.");
}

// Uses a real worktree and TypeScript command while rejecting competing file claims and stale source.
test("immutable ticket pipeline survives restart and rejects stale review evidence", { timeout: 30_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "nodeforge-immutable-e2e-"));
  const root = join(temp, "project");
  let database;
  let workspaceService;
  try {
    await mkdir(join(root, "backend/src"), { recursive: true });
    await writeFile(join(root, ".gitignore"), ".forge/\nnode_modules/\n");
    await writeFile(join(root, "jsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: false, noEmit: true }, include: ["backend/src/**/*.js"] }));
    await writeFile(join(root, "README.md"), "Baseline\n");
    await writeFile(join(root, "obsolete.md"), "Remove me\n");
    await writeFile(join(root, "moved.md"), "Move me\n");
    await writeFile(join(root, "backend/src/check.js"), "export const check = true;\n");
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.invalid");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Baseline");
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
    const stateFileService = createFileService({ projectRoot: root });
    database = await openIndexDatabase(root);
    const options = { projectRoot: root, projectId: "PROJECT-E2E", stateFileService, protocolStorage: { get() {}, save() {} }, indexDatabase: database, codeSearch: createCodeSearch({ database }), fileGraph: createFileGraph({ database }) };
    workspaceService = createTicketWorkspaceService(options);
    const a = await workspaceService.open("TICKET-A");
    const b = await workspaceService.open("TICKET-B");
    const initial = await prepareTicketExecutionContext({ workspace: a, taskId: "TICKET-A", supervisorId: "SUP-A" });
    await prepareTicketExecutionContext({ workspace: b, taskId: "TICKET-B", supervisorId: "SUP-B" });
    assert.equal(initial.state, "created");
    await Promise.allSettled([
      a.changeLedger.write({ path: "README.md", before: "Baseline\n", after: "Ticket A\n" }),
      b.changeLedger.write({ path: "README.md", before: "Baseline\n", after: "Ticket B\n" })
    ]).then((results) => { assert.equal(results.filter((item) => item.status === "fulfilled").length, 1); });
    const rootText = await stateFileService.readFile({ path: "README.md" });
    const owner = rootText === "Ticket A\n" ? a : b;
    const taskId = owner === a ? "TICKET-A" : "TICKET-B";
    await owner.changeLedger.write({ path: "notes/new.md", before: null, after: "Created by ticket\n" });
    await owner.changeLedger.write({ path: "obsolete.md", before: "Remove me\n", after: null });
    await owner.changeLedger.write({ path: "moved.md", before: "Move me\n", after: null });
    await owner.changeLedger.write({ path: "renamed.md", before: null, after: "Move me\n" });
    const coding = await owner.executionContexts.syncManifest(taskId, await owner.changeLedger.snapshot());
    const changedPaths = ["README.md", "moved.md", "notes/new.md", "obsolete.md", "renamed.md"];
    const committed = await owner.gitService.commit(taskId, { paths: changedPaths });
    await owner.executionContexts.update(taskId, coding.version, { state: "committed", review_commit_sha: committed.sha });
    const started = await owner.testService.startTests();
    const job = await finished(owner.testService, started.job_id);
    assert.equal(job.status, "passed", JSON.stringify(job.error ?? job.result));
    const artifact = await owner.testService.assertPassedArtifact();
    assert.equal(artifact.commit_sha, committed.sha);
    assert.equal(artifact.cwd, owner.path);
    assert.equal(artifact.commands[0].kind, "typecheck");
    assert.equal((await inspectTicketProcess(root, "PROJECT-E2E", taskId)).artifact_id, artifact.artifact_id);
    const duplicate = await owner.testService.startTests();
    assert.equal(duplicate.artifact_id, artifact.artifact_id);
    await stateFileService.atomicWrite({ path: "unrelated.txt", content: "Disjoint root edit\n", replace: false });
    assert.equal((await owner.testService.assertPassedArtifact()).artifact_id, artifact.artifact_id);
    await workspaceService.close();
    workspaceService = createTicketWorkspaceService(options);
    const restarted = await workspaceService.open(taskId);
    assert.equal((await restarted.testService.getTestResult({ jobId: started.job_id })).status, "passed");
    assert.equal((await inspectTicketProcess(root, "PROJECT-E2E", taskId)).commit_sha, committed.sha);
    const reviewJob = { task_id: taskId, payload: { commit: committed.sha, base_commit: restarted.base_commit, changed_paths: changedPaths, verification: { artifact_id: artifact.artifact_id } } };
    const evidence = { job: reviewJob, executionContexts: restarted.executionContexts, verificationService: restarted.testService, gitService: restarted.gitService, fileService: restarted.worktreeFileService, projectRoot: restarted.path };
    assert.equal((await assertTicketReviewEvidence(evidence)).files[0].content, rootText);
    const reviewedFiles = (await assertTicketReviewEvidence(evidence)).files;
    assert.equal(reviewedFiles.find((file) => file.path === "notes/new.md").content, "Created by ticket\n");
    assert.equal(reviewedFiles.find((file) => file.path === "obsolete.md").deleted, true);
    assert.equal(reviewedFiles.find((file) => file.path === "moved.md").deleted, true);
    assert.equal(reviewedFiles.find((file) => file.path === "renamed.md").content, "Move me\n");
    await assert.rejects(assertTicketReviewEvidence({ ...evidence, job: { ...reviewJob, payload: { ...reviewJob.payload, verification: { artifact_id: "ARTIFACT-OTHER" } } } }), { code: "REVIEW_EVIDENCE_MISMATCH" });
    await writeFile(join(restarted.path, "untracked.txt"), "Unexpected worktree edit\n");
    await assert.rejects(assertTicketReviewEvidence(evidence), { code: "VERIFY_WORKTREE_DIRTY" });
    await rm(join(restarted.path, "untracked.txt"));
    await restarted.worktreeFileService.atomicWrite({ path: "README.md", content: "Raced review\n", replace: true });
    await assert.rejects(assertTicketReviewEvidence(evidence), { code: "VERIFY_WORKTREE_DIRTY" });
    await restarted.worktreeFileService.atomicWrite({ path: "README.md", content: rootText, replace: true });
    await git(root, "add", "unrelated.txt");
    await git(root, "commit", "-m", "Concurrent project commit");
    await assert.rejects(restarted.integrate(), { code: "TICKET_REVALIDATION_REQUIRED" });
    const retained = await restarted.executionContexts.load(taskId);
    assert.equal(retained.state, "verified");
    assert.equal(retained.verification_artifact_id, artifact.artifact_id);
    const competing = owner === a ? b : a;
    await assert.rejects(competing.changeLedger.write({ path: "README.md", before: rootText, after: "Competing ticket\n" }), { code: "FILE_CLAIM_CONFLICT" });
    await stateFileService.atomicWrite({ path: "README.md", content: "External drift\n", replace: true });
    await assert.rejects(restarted.testService.assertPassedArtifact(), { code: "TICKET_SOURCE_CHANGED" });
    await stateFileService.atomicWrite({ path: "README.md", content: rootText, replace: true });
    await stateFileService.deleteFile({ path: `.forge/runtime/ticket-verification/${taskId}/artifacts/${artifact.artifact_id}.json` });
    await assert.rejects(restarted.testService.assertPassedArtifact(), { code: "VERIFY_ARTIFACT_MISMATCH" });
  } finally {
    await workspaceService?.close();
    await database?.close();
    await rm(temp, { recursive: true, force: true });
  }
});

// Integrates exactly the verified ticket commit and persists a durable receipt before releasing claims.
test("approved ticket commit integrates once with deleted and renamed files", { timeout: 30_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "nodeforge-immutable-integrate-"));
  const root = join(temp, "project");
  let database;
  let service;
  try {
    await mkdir(root, { recursive: true });
    await mkdir(join(root, "backend/src"), { recursive: true });
    await mkdir(join(root, "workflows/agents"), { recursive: true });
    await writeFile(join(root, ".gitignore"), ".forge/\nnode_modules/\n");
    await writeFile(join(root, "jsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, noEmit: true }, include: ["backend/src/**/*.js"] }));
    await writeFile(join(root, "backend/src/check.js"), "export const check = true;\n");
    await writeFile(join(root, "workflows/agents/reviewer.md"), "Review only committed source.\n");
    await writeFile(join(root, "old.md"), "Old\n");
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.invalid");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Baseline");
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
    const fileService = createFileService({ projectRoot: root });
    database = await openIndexDatabase(root);
    const reports = new Map([["task/TICKET-INTEGRATE/final_report", { status: "submitted_for_review", ticket: { id: "TICKET-INTEGRATE", title: "Rename", objective: "Revise destination" }, criteria_check: [], files_changed: [], commits: [] }]]);
    const protocolStorage = { get: async (key) => ({ data: reports.get(key) }), save: async (key, value) => { reports.set(key, value); } };
    service = createTicketWorkspaceService({ projectRoot: root, projectId: "PROJECT-INTEGRATE", stateFileService: fileService, protocolStorage, indexDatabase: database, codeSearch: createCodeSearch({ database }), fileGraph: createFileGraph({ database }) });
    const profiles = createAgentProfileStore({ database });
    const coderId = "66666666-6666-4666-8666-666666666666";
    profiles.create({ agent_id: coderId, agent_name: "Coder", role: "coder", gateway_url: "https://gateway.test/v1", credential_ref: "runtime:coder:api-key", enabled: true, status: "ready", created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z" });
    const occupancy = createAgentOccupancyStore({ database, profiles });
    const coderClaim = await occupancy.claim({ agentId: coderId, taskId: "TICKET-INTEGRATE", supervisorId: "SUP-INTEGRATE" });
    assert.ok(coderClaim);
    const workspace = await service.open("TICKET-INTEGRATE");
    await prepareTicketExecutionContext({ workspace, taskId: "TICKET-INTEGRATE", supervisorId: "SUP-INTEGRATE" });
    await workspace.changeLedger.write({ path: "old.md", before: "Old\n", after: null });
    await workspace.changeLedger.write({ path: "new.md", before: null, after: "Old\n" });
    const coding = await workspace.executionContexts.syncManifest("TICKET-INTEGRATE", await workspace.changeLedger.snapshot());
    const commit = await workspace.gitService.commit("Ticket rename", { paths: ["old.md", "new.md"] });
    await workspace.executionContexts.update("TICKET-INTEGRATE", coding.version, { state: "committed", review_commit_sha: commit.sha });
    const job = await workspace.testService.startTests();
    assert.equal((await finished(workspace.testService, job.job_id)).status, "passed");
    const artifact = await workspace.testService.assertPassedArtifact();
    const review = await assertTicketReviewEvidence({ job: { task_id: "TICKET-INTEGRATE", payload: { commit: commit.sha, base_commit: workspace.base_commit, changed_paths: ["old.md", "new.md"], verification: { artifact_id: artifact.artifact_id } } }, executionContexts: workspace.executionContexts, verificationService: workspace.testService, gitService: workspace.gitService, fileService: workspace.worktreeFileService, projectRoot: workspace.path });
    assert.equal(review.files.find((file) => file.path === "old.md").deleted, true);
    const findings = await workspace.reviewFindings.recordReview({ verdict: "request_changes", findings: ["Update new.md after the rename."], artifactId: artifact.artifact_id, commitSha: commit.sha });
    assert.equal(findings.findings[0].finding_id, "REV-1");
    await assert.rejects(workspace.reviewFindings.recordReview({ verdict: "approved", findings: [], artifactId: artifact.artifact_id, commitSha: commit.sha }), { code: "REVIEW_FINDINGS_UNRESOLVED" });
    await workspace.changeLedger.write({ path: "new.md", before: "Old\n", after: "Revised\n" });
    const revised = await workspace.executionContexts.syncManifest("TICKET-INTEGRATE", await workspace.changeLedger.snapshot());
    const finalCommit = await workspace.gitService.commit("Resolve reviewer finding", { paths: ["new.md"] });
    await workspace.executionContexts.update("TICKET-INTEGRATE", revised.version, { state: "committed", review_commit_sha: finalCommit.sha });
    const revisedJob = await workspace.testService.startTests();
    assert.equal((await finished(workspace.testService, revisedJob.job_id)).status, "passed");
    const finalArtifact = await workspace.testService.assertPassedArtifact();
    await workspace.reviewFindings.recordCoderReport({ report: { summary: "The rename requires a revised destination.", acceptance_criteria: ["Renamed source is updated"], implementation_scope: { changed_files: ["new.md"], not_changed_files: [], scope_rationale: "Only the destination needs a revision." }, evidence: [{ type: "verification", reference: finalArtifact.artifact_id, result: "passed" }], reviewer_notes: [] }, artifact: finalArtifact, idempotencyKey: `${finalArtifact.artifact_id}:report` });
    const unavailable = createReviewWorker({ agentResolver: { resolveAvailable: () => ({ agent_id: "REVIEWER-E2E", agent_name: "Reviewer", provider: "codex", enabled: true, status: "ready" }) }, codexSdkGateway: { execute: async () => { throw new Error("SDK must not run without source tools."); } }, fileService: workspace.worktreeFileService, gitService: workspace.worktreeGitService, projectRoot: workspace.path, executionContexts: workspace.executionContexts, verificationService: workspace.testService, reviewFindings: workspace.reviewFindings });
    await assert.rejects(unavailable.review({ task_id: "TICKET-INTEGRATE", agent_id: "CODER-E2E", payload: { ticket: { id: "TICKET-INTEGRATE" }, commit: finalCommit.sha, base_commit: workspace.base_commit, changed_paths: ["old.md", "new.md"], verification: { artifact_id: finalArtifact.artifact_id } } }), { code: "REVIEW_TOOLS_UNAVAILABLE" });
    await workspace.reviewFindings.recordResolutions([{ finding_id: "REV-1", status: "fixed", changed_paths: ["new.md"] }], finalArtifact);
    await workspace.reviewFindings.recordReview({ verdict: "approved", findings: [], adjudications: [{ finding_id: "REV-1", decision: "fixed", reason: "Reviewer confirmed the revised destination against the new artifact.", evidence_refs: [finalArtifact.artifact_id] }], reviewerId: "REVIEWER-E2E", artifactId: finalArtifact.artifact_id, commitSha: finalCommit.sha });
    const completion = { workspace, reviewerClaim: null, agentOccupancy: occupancy, coderClaim, taskId: "TICKET-INTEGRATE", ownerId: "SUP-INTEGRATE", request: { request_id: "REQUEST-INTEGRATE" }, projectLogger: () => {}, publishTicketOutcome: async () => {}, selected: { agent_id: coderId }, result: { summary: "done", tool_events: [] } };
    const completed = await completeApprovedTicket(completion);
    assert.equal(completed, null);
    assert.equal(occupancy.getByTask("TICKET-INTEGRATE"), null);
    assert.equal(profiles.getById(coderId).status, "ready");
    assert.equal((await workspace.executionContexts.load("TICKET-INTEGRATE")).state, "terminal");
    const witnessed = await inspectTicketProcess(root, "PROJECT-INTEGRATE", "TICKET-INTEGRATE");
    assert.equal(witnessed.context_state, "terminal");
    assert.equal(witnessed.active_claim, null);
    assert.equal((await workspace.integrate()).repeated, true);
    assert.equal(await completeApprovedTicket(completion), null);
    assert.equal(await git(root, "rev-parse", "HEAD"), finalCommit.sha);
    assert.equal(await fileService.readFile({ path: "new.md" }), "Revised\n");
    const receipt = JSON.parse(await fileService.readFile({ path: ".forge/runtime/ticket-integrations/TICKET-INTEGRATE.json" }));
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.reviewed_commit, finalArtifact.commit_sha);
    await service.close();
    await database.close();
    database = await openIndexDatabase(root);
    assert.equal(createAgentOccupancyStore({ database, profiles: createAgentProfileStore({ database }) }).listActive().length, 0);
  } finally {
    await service?.close();
    await database?.close();
    await rm(temp, { recursive: true, force: true });
  }
});
