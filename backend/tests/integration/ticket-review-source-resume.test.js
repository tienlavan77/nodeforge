// Ensures independent review and integration retain committed evidence when platform edits change the shared root.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile as callback } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketRootWorkspace } from "../../src/modules/supervisor/ticket/ticket-root-workspace.js";
import { prepareTicketExecutionContext } from "../../src/modules/supervisor/ticket/ticket-execution-context.js";
import { prepareTicketReviewContext } from "../../src/modules/supervisor/ticket/ticket-review-context.js";
import { assertTicketReviewEvidence } from "../../src/modules/supervisor/ticket/ticket-review-evidence.js";
import { createReviewWorker } from "../../src/modules/supervisor/review/review-worker.js";
import { captureVerificationEnvironment, persistVerificationEnvironment } from "../../src/modules/supervisor/ticket/ticket-verification-environment.js";

const execFile = promisify(callback);
// Runs Git only inside the disposable source-evidence fixture.
async function git(root, ...args) { return (await execFile("git", ["-C", root, ...args])).stdout.trim(); }
// Computes the same source digest used by persisted verification evidence.
const hash = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

test("Reviewer keeps committed evidence while Coder resumes on live source with stale-write protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-review-resume-source-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "config", "user.email", "nodeforge-test@localhost");
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "source.js"), "const value = 1;\n");
    await git(root, "add", ".gitignore", "source.js");
    await git(root, "commit", "-qm", "baseline");
    await writeFile(join(root, "workspace-only.md"), "untracked cleanup\n");
    const files = createFileService({ projectRoot: root });
    let finalReport;
    const service = createTicketRootWorkspace({ projectRoot: root, projectId: "PROJECT-1", stateFileService: files,
      protocolStorage: { save: async (_ref, data) => { finalReport = data; }, get: async () => ({ data: finalReport }) },
      indexDatabase: { all: () => [] }, codeSearch: { search: async () => [] }, fileGraph: { getDependencies: () => [], getDependents: () => [] } });
    const workspace = await service.open("TICKET-1");
    const ticket = { id: "TICKET-1", project_id: "PROJECT-1", verification_plan: [], title: "Refresh source", objective: "Preserve reviewed evidence", acceptance_criteria: ["Committed source is reviewed"] };
    const input = { workspace, ticket, taskId: ticket.id, supervisorId: "SUP-1" };
    await prepareTicketExecutionContext(input);
    const submitted = "const value = 2;\n";
    await workspace.changeLedger.write({ path: "source.js", before: "const value = 1;\n", after: submitted });
    await workspace.changeLedger.write({ path: "workspace-only.md", before: "untracked cleanup\n", after: null });
    let context = await workspace.executionContexts.syncManifest(ticket.id, await workspace.changeLedger.snapshot());
    const commit = await workspace.gitService.commit("ticket change");
    context = await workspace.executionContexts.update(ticket.id, context.version, { state: "committed", review_commit_sha: commit.sha });
    const command = { kind: "typecheck", argv: ["node", "check"] };
    const artifact = { artifact_id: "ARTIFACT-REVIEW", status: "passed", commit_sha: commit.sha, source_revision: context.source_revision,
      manifest_sha: context.manifest_sha, base_sha: context.base_sha, tree_sha: await git(root, "rev-parse", `${commit.sha}^{tree}`),
      changed_paths: ["source.js"], file_checksums: { "source.js": hash(submitted), "workspace-only.md": null }, policy_version: "ticket-verification-v8",
      environment: await persistVerificationEnvironment(root, await captureVerificationEnvironment({ projectRoot: root, ticketPaths: ["source.js"] })),
      planned_commands: [command], commands: [{ ...command, exit_code: 0, output_sha256: hash("") }] };
    await files.atomicWrite({ path: `.forge/runtime/ticket-verification/${ticket.id}/artifacts/${artifact.artifact_id}.json`, content: JSON.stringify(artifact), replace: false });
    context = await workspace.executionContexts.update(ticket.id, context.version, { state: "reviewing", verification_artifact_id: artifact.artifact_id });
    const coverage = [{ criterion_id: "AC-1", criterion: ticket.acceptance_criteria[0], status: "verified", artifact_id: artifact.artifact_id }];
    const report = { summary: "Committed fixture source is ready for review.", acceptance_criteria: ticket.acceptance_criteria, acceptance_coverage: coverage };
    await workspace.reviewFindings.recordCoderReport({ report, artifact, idempotencyKey: "fixture-report" });
    finalReport = { ticket, status: "submitted_for_review", criteria_check: coverage, agent_report: report,
      verify_result: { artifact_id: artifact.artifact_id, commit_id: artifact.commit_sha } };
    const external = "const value = 3; // platform repair\n";
    await writeFile(join(root, "source.js"), external);
    assert.deepEqual(await prepareTicketExecutionContext(input), context);
    await workspace.changeLedger.resume({ observe_changes: true });
    await assert.rejects(workspace.changeLedger.snapshot(), { code: "TICKET_SOURCE_CHANGED" });
    const resume = { base_commit: context.base_sha, verification: artifact };
    assert.deepEqual(await prepareTicketReviewContext({ ...input, resume }), context);
    const evidence = await assertTicketReviewEvidence({ job: { task_id: ticket.id, payload: { commit: commit.sha, verification: artifact, execution_context: context, changed_paths: artifact.changed_paths } },
      executionContexts: workspace.executionContexts, verificationService: workspace.testService, gitService: workspace.gitService,
      fileService: workspace.worktreeFileService, projectRoot: root });
    assert.equal(evidence.files[0].content, submitted);
    assert.equal(evidence.files[0].sha256, artifact.file_checksums["source.js"]);
    assert.deepEqual(evidence.files[1], { path: "workspace-only.md", content: null, sha256: null, deleted: true });
    let reviewCalls = 0;
    const worker = createReviewWorker({ projectRoot: root, executionContexts: workspace.executionContexts,
      verificationService: workspace.testService, gitService: workspace.gitService, fileService: workspace.worktreeFileService,
      rulesFileService: { readForIndex: async () => ({ content: "Review committed evidence and workspace cleanup receipts." }) },
      agentResolver: { resolveAvailable: () => ({ agent_id: "REVIEWER-1", provider: "openai" }) },
      openaiSdkGateway: { execute: async ({ prompt, options }) => {
        reviewCalls += 1;
        assert.match(prompt, /workspace-only.md.*no Git delta/);
        assert.match(prompt, /diff --git a\/source.js/);
        const cleanup = await options.forgeTools.registry.review_diff.execute({ path: "workspace-only.md" });
        assert.match(cleanup.patch, /no Git delta/);
        assert.equal(cleanup.review_evidence.artifact_id, artifact.artifact_id);
        const previous = await options.forgeTools.registry.review_diff.execute({ path: "workspace-only.md", base: "previous_review" });
        assert.match(previous.patch, /no Git delta/);
        await assert.rejects(() => options.forgeTools.registry.review_diff.execute({ path: "unknown.md" }), { code: "ENOENT" });
        return { text: '{"verdict":"approved","findings":[]}' };
      } } });
    const verdict = await worker.review({ task_id: ticket.id, agent_id: "CODER-1", payload: {
      ticket: { ...ticket, execution_policy: { legacy_review_report: true } }, previous_review_commit: context.base_sha,
      commit: commit.sha, verification: artifact, execution_context: context, changed_paths: artifact.changed_paths } });
    assert.equal(verdict.verdict, "approved");
    assert.equal(reviewCalls, 1);
    assert.equal((await workspace.integrate()).sha, commit.sha);
    assert.equal(await readFile(join(root, "source.js"), "utf8"), external);
    assert.deepEqual(await workspace.executionContexts.load(ticket.id), context);
    await assert.rejects(workspace.changeLedger.write({ path: "source.js", before: submitted, after: "const value = 4;\n" }), { code: "CHECKSUM_MISMATCH" });
    await workspace.changeLedger.write({ path: "source.js", before: external, after: "const value = 4;\n" });
    assert.equal(await readFile(join(root, "source.js"), "utf8"), "const value = 4;\n");
    await workspace.executionContexts.update(ticket.id, context.version, { manifest_sha: "changed-after-verification" });
    await assert.rejects(prepareTicketReviewContext({ ...input, resume }), { code: "VERIFY_ARTIFACT_MISMATCH" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
