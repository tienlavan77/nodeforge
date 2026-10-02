// Runs a committed ticket review through the real OpenAI Agents SDK Runner and Forge read tool.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ScriptedModel, functionCall, assistantMessage } from "@openai/agents/testing";
import { createOpenAiSdkGateway } from "../../src/modules/agent/openai-sdk-gateway.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createCodeSearch } from "../../src/modules/index/code-search.js";
import { createFileGraph } from "../../src/modules/index/file-graph.js";
import { createCodeCacheService } from "../../src/modules/context/code-cache-service.js";
import { createTicketWorkspaceService } from "../../src/modules/supervisor/ticket-workspace-service.js";
import { prepareTicketExecutionContext } from "../../src/modules/supervisor/ticket-execution-context.js";
import { createReviewWorker } from "../../src/modules/supervisor/review-worker.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/reviewer-forge-tools.js";
import { assertTicketReviewEvidence } from "../../src/modules/supervisor/ticket-review-evidence.js";

const execFile = promisify(execFileCallback);

// Creates a real Git fixture while keeping model responses deterministic and offline.
async function git(root, ...args) { return (await execFile("git", ["-C", root, ...args])).stdout.trim(); }

// Waits for the persisted verification receipt before dispatching the SDK Reviewer.
async function verified(service, jobId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await service.getTestResult({ jobId });
    if (result.status !== "running") return result;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("Verification did not finish.");
}

// Asserts the SDK calls Forge sed_lines and cannot approve a different artifact.
test("real SDK Reviewer reads the verified commit through Forge tools", { timeout: 30_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "nodeforge-sdk-review-"));
  const root = join(temp, "project");
  let database;
  let workspaces;
  try {
    await mkdir(join(root, "backend/src"), { recursive: true });
    await mkdir(join(root, "workflows/agents"), { recursive: true });
    await writeFile(join(root, ".gitignore"), ".forge/\nnode_modules/\n");
    await writeFile(join(root, "jsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, noEmit: true }, include: ["backend/src/**/*.js"] }));
    await writeFile(join(root, "backend/src/check.js"), "export const check = true;\n");
    await writeFile(join(root, "workflows/agents/reviewer.md"), "Review the exact committed source.\n");
    await writeFile(join(root, "README.md"), "Baseline\n");
    await git(root, "init");
    await git(root, "config", "user.email", "test@example.invalid");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "Baseline");
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
    const stateFiles = createFileService({ projectRoot: root });
    database = await openIndexDatabase(root);
    workspaces = createTicketWorkspaceService({ projectRoot: root, projectId: "PROJECT-SDK", stateFileService: stateFiles, protocolStorage: { get() {}, save() {} }, indexDatabase: database, codeSearch: createCodeSearch({ database }), fileGraph: createFileGraph({ database }) });
    const workspace = await workspaces.open("TICKET-SDK");
    await prepareTicketExecutionContext({ workspace, taskId: "TICKET-SDK", supervisorId: "SUP-SDK" });
    await workspace.changeLedger.write({ path: "README.md", before: "Baseline\n", after: "Reviewed source\n" });
    const coding = await workspace.executionContexts.syncManifest("TICKET-SDK", await workspace.changeLedger.snapshot());
    const commit = await workspace.gitService.commit("Ticket SDK review", { paths: ["README.md"] });
    await workspace.executionContexts.update("TICKET-SDK", coding.version, { state: "committed", review_commit_sha: commit.sha });
    const started = await workspace.testService.startTests();
    assert.equal((await verified(workspace.testService, started.job_id)).status, "passed");
    const artifact = await workspace.testService.assertPassedArtifact();
    const model = new ScriptedModel([
      [functionCall("sed_lines", { path: "README.md", start_line: 1, end_line: 1 }, { callId: "CALL-READ" })],
      [assistantMessage('{"verdict":"approved","findings":[]}')]
    ]);
    const gateway = createOpenAiSdkGateway({ providerFactory: { createForAgent: async (profile) => ({ provider: { getModel: () => model }, profile: { ...profile, reasoning: { effort: "none" } } }) } });
    const events = [];
    const reviewer = { agent_id: "REVIEWER-SDK", agent_name: "SDK Reviewer", role: "reviewer", provider: "openai", model: "gpt-4o-mini", enabled: true, status: "ready" };
    const cache = createCodeCacheService({ projectId: "PROJECT-SDK-REVIEW", fileService: workspace.worktreeFileService });
    const worker = createReviewWorker({ agentResolver: { resolveAvailable: () => reviewer }, openaiSdkGateway: gateway, fileService: workspace.worktreeFileService, gitService: workspace.worktreeGitService, codeCache: cache, projectRoot: workspace.path, executionContexts: workspace.executionContexts, verificationService: workspace.testService, projectLogger: (event) => events.push(event) });
    const job = { task_id: "TICKET-SDK", correlation_id: "CORR-SDK", request_id: "REQ-SDK", agent_id: "CODER-SDK", payload: { ticket: { id: "TICKET-SDK", execution_policy: { legacy_review_report: true } }, commit: commit.sha, base_commit: workspace.base_commit, changed_paths: ["README.md"], verification: { artifact_id: artifact.artifact_id } } };
    const verdict = await worker.review(job);
    assert.equal(verdict.verdict, "approved");
    const ticketEvidence = await assertTicketReviewEvidence({ job, executionContexts: workspace.executionContexts, verificationService: workspace.testService, gitService: workspace.worktreeGitService, fileService: workspace.worktreeFileService, projectRoot: workspace.path });
    const reviewerTools = createReviewerForgeTools({ fileService: workspace.worktreeFileService, projectRoot: workspace.path, job, reviewer, codeCache: cache, ticketEvidence });
    const sourceInput = { path: "README.md", start_line: 1, end_line: 1 };
    const source = await reviewerTools.registry.sed_lines.execute(sourceInput);
    assert.deepEqual(source.review_evidence, { artifact_id: artifact.artifact_id, commit_sha: commit.sha, manifest_sha: ticketEvidence.context.manifest_sha, sha256: ticketEvidence.files[0].sha256 });
    ticketEvidence.files[0].content = "Different source\n";
    await assert.rejects(reviewerTools.registry.sed_lines.execute(sourceInput), { code: "REVIEW_SOURCE_MISMATCH" });
    assert.equal(model.calls.length, 2);
    assert.ok(events.some((event) => event.event_name === "review.tool_call" && event.payload.tool === "sed_lines" && event.status === "success"), JSON.stringify(events.filter((event) => event.event_name === "review.tool_call")));
    assert.ok(events.some((event) => event.event_name === "review.tool_call" && event.payload.review_evidence?.commit_sha === commit.sha && event.payload.review_evidence?.artifact_id === artifact.artifact_id));
    assert.equal((await workspace.executionContexts.load("TICKET-SDK")).state, "reviewing");
    await assert.rejects(worker.review({ ...job, payload: { ...job.payload, verification: { artifact_id: "ARTIFACT-OTHER" } } }), { code: "REVIEW_EVIDENCE_MISMATCH" });
    const noSourceTools = createReviewWorker({ agentResolver: { resolveAvailable: () => reviewer }, openaiSdkGateway: gateway, fileService: workspace.worktreeFileService, gitService: workspace.worktreeGitService, projectRoot: workspace.path, executionContexts: workspace.executionContexts, verificationService: workspace.testService });
    await assert.rejects(noSourceTools.review(job), { code: "REVIEW_TOOLS_UNAVAILABLE" });
    assert.equal(model.calls.length, 2);
    cache.close();
  } finally { await workspaces?.close(); await database?.close(); await rm(temp, { recursive: true, force: true }); }
});
