// Exercises alternative implementations through real root commits, executable verification, reports, and a declared Reviewer provider double.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createCodeSearch } from "../../src/modules/index/code-search.js";
import { createFileGraph } from "../../src/modules/index/file-graph.js";
import { createTicketWorkspaceService } from "../../src/modules/supervisor/ticket-workspace-service.js";
import { prepareTicketExecutionContext } from "../../src/modules/supervisor/ticket-execution-context.js";
import { createReportDoneTool } from "../../src/tools/agent-report-tool.js";
import { createReviewWorker } from "../../src/modules/supervisor/review-worker.js";
import { REVIEW_AUTONOMY_PROMPT } from "../../src/shared/implementation-autonomy.js";

const execFile = promisify(execFileCallback);
const criterion = "Return the sum of all values, including zero for empty input";
const sourcePath = "src/total.mjs";
const testPath = "backend/tests/total.test.mjs";
const baseline = "// Computes totals for the behavior witness.\nexport const total = () => -1;\n";
const variants = {
  reduce: "// Computes totals using the suggested reduction.\nexport const total = (values) => values.reduce((sum, value) => sum + value, 0);\n",
  loop: "// Computes totals using an alternative loop.\nexport function total(values) { let sum = 0; for (const value of values) sum += value; return sum; }\n",
  broken: "// Follows reduction guidance but misses empty-input behavior.\nexport const total = (values) => values.reduce((sum, value) => sum + value);\n"
};

// Uses Git only inside disposable repositories to establish genuine revision-bound witness evidence.
async function git(root, ...args) { return (await execFile("git", ["-C", root, ...args])).stdout.trim(); }

// Waits for the Node-owned verification receipt, not a fabricated passing callback.
async function finished(service, jobId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await service.getTestResult({ jobId });
    if (result.status !== "running") return result;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("Autonomy witness verification timed out");
}

// Builds and evaluates one implementation without invoking live agent providers or changing project runtime state.
async function witness(variant) {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-autonomy-"));
  let database;
  let service;
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "backend/tests"), { recursive: true });
    await mkdir(join(root, "workflows/agents/reviewer"), { recursive: true });
    await writeFile(join(root, ".gitignore"), ".forge/\nnode_modules/\n");
    await writeFile(join(root, sourcePath), baseline);
    await writeFile(join(root, "src/unchanged.mjs"), "// Unchanged candidate used to reject edit-all obligations.\nexport const untouched = true;\n");
    await writeFile(join(root, testPath), "// Verifies observable totals independently of the implementation.\nimport assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { total } from '../../src/total.mjs';\ntest('totals', () => { assert.equal(total([]), 0); assert.equal(total([2, -3, 5]), 4); assert.equal(total([7]), 7); });\n");
    await writeFile(join(root, "workflows/agents/reviewer/README.md"), await readFile("workflows/agents/reviewer/README.md", "utf8"));
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.invalid");
    await git(root, "config", "user.name", "Autonomy Witness");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Witness baseline");
    const files = createFileService({ projectRoot: root });
    database = await openIndexDatabase(root);
    const reports = new Map();
    const protocolStorage = { get: async (key) => ({ data: reports.get(key) }), save: async (key, value) => { reports.set(key, value); } };
    service = createTicketWorkspaceService({ rootOnly: true, projectRoot: root, projectId: "PROJECT-AUTONOMY", stateFileService: files, protocolStorage, indexDatabase: database, codeSearch: createCodeSearch({ database }), fileGraph: createFileGraph({ database }) });
    const ticket = { id: "T-AUTONOMY", title: "Correct totals", objective: "Return accurate totals; optional implementation guidance: use reduce", acceptance_criteria: [criterion], verification_plan: [{ criterion_ids: ["AC-1"], kind: "test", test_path: testPath }] };
    const workspace = await service.open(ticket.id);
    await prepareTicketExecutionContext({ workspace, taskId: ticket.id, supervisorId: "SUP-AUTONOMY", ticket });
    await workspace.changeLedger.write({ path: sourcePath, before: baseline, after: variants[variant] });
    const coding = await workspace.executionContexts.syncManifest(ticket.id, await workspace.changeLedger.snapshot());
    const committed = await workspace.gitService.commit(`Witness ${variant}`, { paths: [sourcePath] });
    await workspace.executionContexts.update(ticket.id, coding.version, { state: "committed", review_commit_sha: committed.sha });
    const started = await workspace.testService.startTests();
    const verification = await finished(workspace.testService, started.job_id);
    const report = createReportDoneTool({ reportService: workspace.reportService, verificationService: workspace.testService, reviewFindings: workspace.reviewFindings });
    if (variant === "broken") {
      assert.equal(verification.status, "failed");
      await assert.rejects(workspace.testService.assertPassedArtifact());
      assert.equal(reports.size, 0);
      return { blocked_at: "verification", commit: committed.sha };
    }
    assert.equal(verification.status, "passed", JSON.stringify(verification.error));
    const artifact = await workspace.testService.assertPassedArtifact();
    assert.equal(artifact.commit_sha, committed.sha);
    assert.deepEqual(artifact.changed_paths, [sourcePath]);
    await report.execute({
      summary: `Behavior verified using ${variant}; guidance is advisory`,
      acceptance_coverage: [{ criterion_id: "AC-1", command_kind: "test", test_path: testPath }],
      implementation_scope: { changed_files: [sourcePath], not_changed_files: ["src/unchanged.mjs"], scope_rationale: "Only the total implementation needs a change" },
      evidence: [{ type: "verification", reference: artifact.artifact_id, result: "Observable total assertions passed" }]
    }, { ticket });
    assert.equal(reports.get(`task/${ticket.id}/final_report`).status, "submitted_for_review");
    let providerCalls = 0;
    const worker = createReviewWorker({
      agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer-witness", provider: "openai", role: "reviewer" }) },
      openaiSdkGateway: { execute: async ({ prompt }) => {
        providerCalls += 1;
        assert.ok(prompt.includes(REVIEW_AUTONOMY_PROMPT));
        assert.ok(prompt.includes(artifact.artifact_id));
        assert.ok(prompt.includes(criterion));
        return { text: JSON.stringify({ verdict: "approved", findings: [], adjudications: [] }) };
      } },
      fileService: workspace.worktreeFileService, rulesFileService: files, gitService: workspace.worktreeGitService,
      codeSearch: workspace.codeSearch, codeCache: workspace.codeCache, projectRoot: root,
      executionContexts: workspace.executionContexts, verificationService: workspace.testService, reviewFindings: workspace.reviewFindings
    });
    const reviewJob = { task_id: ticket.id, agent_id: "coder-witness", payload: { ticket, commit: committed.sha, base_commit: workspace.base_commit, changed_paths: artifact.changed_paths, verification: { artifact_id: artifact.artifact_id } } };
    await assert.rejects(worker.review({ ...reviewJob, payload: { ...reviewJob.payload, verification: { artifact_id: "ARTIFACT-STALE" } } }), { code: "REVIEW_EVIDENCE_MISMATCH" });
    assert.equal(providerCalls, 0);
    const verdict = await worker.review(reviewJob);
    assert.equal(verdict.verdict, "approved");
    await workspace.reviewFindings.recordReview({ ...verdict, reviewerId: verdict.reviewer_id, artifactId: artifact.artifact_id, commitSha: artifact.commit_sha });
    assert.equal(providerCalls, 1);
    assert.equal(await readFile(join(root, "src/unchanged.mjs"), "utf8"), "// Unchanged candidate used to reject edit-all obligations.\nexport const untouched = true;\n");
    return { commit: artifact.commit_sha, artifact: artifact.artifact_id, checksum: artifact.file_checksums[sourcePath], verdict: verdict.verdict };
  } finally {
    await service?.close();
    await database?.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("two internal solutions satisfy the same behavioral contract through root verification/report/review", { timeout: 60_000 }, async () => {
  const reduction = await witness("reduce");
  const iteration = await witness("loop");
  assert.equal(reduction.verdict, "approved");
  assert.equal(iteration.verdict, "approved");
  assert.notEqual(reduction.commit, iteration.commit);
  assert.notEqual(reduction.artifact, iteration.artifact);
  assert.notEqual(reduction.checksum, iteration.checksum);
});

test("guidance-following code with wrong behavior is stopped before reporting or review", { timeout: 30_000 }, async () => {
  assert.equal((await witness("broken")).blocked_at, "verification");
});
