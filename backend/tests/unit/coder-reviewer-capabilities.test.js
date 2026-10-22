// Verifies Outcomes O1–O6 for expanded Coder and Reviewer capabilities under NodeForge governance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { isAgentPathAllowed } from "../../src/tools/tool-authorization.js";
import { assertDiscoveryBudget, cloneExplorationState, recordRead } from "../../src/tools/exploration-state.js";
import { createReportDoneTool } from "../../src/tools/agent-report-tool.js";
import { createCheckTestTool } from "../../src/tools/agent-verification-tools.js";
import { createTicketFocusedCheck } from "../../src/modules/supervisor/ticket-focused-check.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket-change-ledger.js";
import { createTicketExecutionContextStore } from "../../src/modules/supervisor/ticket-execution-context.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/reviewer-forge-tools.js";
import { createTicketReviewFindingsStore } from "../../src/modules/supervisor/ticket-review-findings.js";
import { parseReviewVerdict } from "../../src/modules/supervisor/review-verdict-contract.js";
import { publishAutomaticReviewOutcome } from "../../src/modules/supervisor/automatic-review-audit.js";

const sha = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

test("O1: Coder can read docs/** outside allowed_file_paths while writes to docs/** remain blocked unless explicitly allowed", () => {
  const coderContext = {
    agent_identity: { agent_id: "coder-1", role: "coder" },
    allowed_file_paths: ["backend/src/a.js"],
    allowed_prefixes: []
  };
  assert.equal(isAgentPathAllowed("docs/architecture.md", coderContext, { operation: "read" }), true);
  assert.equal(isAgentPathAllowed("docs/guides/setup.md", coderContext, { operation: "read" }), true);
  assert.equal(isAgentPathAllowed("docs/architecture.md", coderContext, { operation: "write" }), false);
  assert.equal(isAgentPathAllowed("workflows/plan.md", coderContext, { operation: "read" }), false);

  const docsWriteContext = {
    agent_identity: { agent_id: "coder-1", role: "coder" },
    allowed_file_paths: ["docs/architecture.md"],
    allowed_prefixes: []
  };
  assert.equal(isAgentPathAllowed("docs/architecture.md", docsWriteContext, { operation: "write" }), true);
});

test("O1: check_test returns redacted diagnostics for the same task_id and blocks cross-ticket access", async () => {
  const testService = {
    async getTestResult({ jobId, taskId }) {
      if (taskId !== "TASK-1") throw Object.assign(new Error("Forbidden"), { code: "TEST_JOB_FORBIDDEN" });
      return { job_id: jobId, task_id: "TASK-1", status: "failed", stdout_redacted: "test output [REDACTED]", stderr_redacted: "assertion failed" };
    }
  };
  const checkTest = createCheckTestTool({ testService });
  const okResult = await checkTest.execute({ job_id: "CHECK-123" }, { task_id: "TASK-1" });
  assert.equal(okResult.stdout_redacted, "test output [REDACTED]");
  await assert.rejects(() => checkTest.execute({ job_id: "CHECK-123" }, { task_id: "TASK-2" }), { code: "TEST_JOB_FORBIDDEN" });
});

test("O2: pre-edit discovery grants a synchronized +1 extension when target_symbol is supplied and unproductive_streak is 0, and report_done supports needs_context", async () => {
  const context = {
    exploration_state: cloneExplorationState({ read_limit: 2, search_limit: 2, edit_must_start_by: 2, discovery_limit: 5 })
  };
  assertDiscoveryBudget(context, "read");
  recordRead(context, { path: "backend/src/a.js", window: "1-20" });
  assertDiscoveryBudget(context, "read");
  recordRead(context, { path: "backend/src/b.js", window: "1-20" });

  assert.throws(() => assertDiscoveryBudget(context, "read"), { code: "EXPLORATION_TYPE_BUDGET_EXHAUSTED" });

  assertDiscoveryBudget(context, "read", { target_symbol: "createService" });
  assert.equal(context.exploration_state.preedit_extensions, 1);
  assert.equal(context.exploration_state.read_limit, 3);
  assert.equal(context.exploration_state.edit_must_start_by, 3);
  recordRead(context, { path: "backend/src/c.js", window: "1-20" });

  assert.throws(() => assertDiscoveryBudget(context, "read", { target_symbol: "anotherSymbol" }), { code: "EXPLORATION_TYPE_BUDGET_EXHAUSTED" });

  const saved = [];
  const reportDone = createReportDoneTool({
    reportService: {
      buildFinalReport: async ({ ticket, status, reason }) => ({ ticket_id: ticket.id, status, reason }),
      saveReport: async (id, report) => saved.push({ id, report }),
      writeReportFile: async () => {}
    }
  });
  await assert.rejects(
    () => reportDone.execute({ status: "needs_context", summary: "Missing contract for FooService" }, { ticket: { id: "TASK-2", acceptance_criteria: ["AC1"] } }),
    { code: "CODER_NEEDS_CONTEXT" }
  );
  assert.equal(saved.length, 1);
  assert.equal(saved[0].report.agent_report.status, "needs_context");
});

test("O3: pre-commit run_check materializes working ledger overlay with pre_commit: true, and authorized_create_prefixes + rollback unlink new files", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-o3-"));
  try {
    const fileService = createFileService({ projectRoot: root });
    const ledger = createTicketChangeLedger({ fileService, projectId: "P-1" });
    const contexts = createTicketExecutionContextStore({ fileService, projectId: "P-1", projectRoot: root });
    const baseSha = "a".repeat(40);
    await contexts.create({
      taskId: "T-O3",
      supervisorId: "SUP-1",
      baseSha,
      baseline: { file_checksums: { "src/existing.js": sha("export const a = 1;\n") } },
      authorizedCreatePrefixes: ["src/helpers"],
      mutableFileBudget: 2
    });
    await mkdir(join(root, "src/helpers"), { recursive: true });
    await writeFile(join(root, "src/existing.js"), "export const a = 1;\n");

    await contexts.assertApprovedPath("T-O3", "src/helpers/new-helper.js");
    await ledger.write({ taskId: "T-O3", path: "src/helpers/new-helper.js", before: null, after: "// Helper\nexport const h = 2;\n" });
    await assert.rejects(() => contexts.assertApprovedPath("T-O3", "src/other/forbidden.js"), { code: "TICKET_BASELINE_SCOPE" });

    let materializedOverlay = null;
    const runCheck = createTicketFocusedCheck({
      taskId: "T-O3",
      projectRoot: root,
      worktreeFileService: fileService,
      ledger,
      executionContexts: contexts,
      stateFileService: fileService,
      assertIdentity: async () => ({}),
      assertArchiveSource: async () => {},
      runCommand: async () => ({ exit_code: 0, stdout: "ok", stderr: "", output_sha256: sha("ok") }),
      safeOutput: (s) => s,
      captureEnvironment: async () => ({ files: [], sha256: "env" }),
      materialize: async ({ commitSha, overlayFiles }) => {
        assert.equal(commitSha, baseSha);
        materializedOverlay = overlayFiles;
        return { path: root, temp_dir: root, environment: null, cleanup: async () => {} };
      }
    });
    const receipt = await runCheck({ type: "test", command: "node --test backend/tests/unit/ticket-focused-check.test.js" });
    assert.equal(receipt.pre_commit, true);
    assert.equal(receipt.commit_sha, null);
    assert.equal(materializedOverlay["src/helpers/new-helper.js"], "// Helper\nexport const h = 2;\n");

    await ledger.rollback("T-O3", { close: true });
    await assert.rejects(() => fileService.readFile({ path: "src/helpers/new-helper.js" }), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("O4 & O5: Reviewer elastic budget, symbol outline preservation, review_diff, and run_review_check budget cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-o4-o5-"));
  try {
    const path = "src/mod.js";
    const content = "// Module\nexport function computeTotal(items) {\n  return items.length;\n}\n";
    const fileSha = sha(content);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, path), content);
    const fileService = createFileService({ projectRoot: root });
    const manifestPaths = Array.from({ length: 10 }, (_, idx) => idx === 0 ? path : `src/f${idx}.js`);
    const ticketEvidence = {
      paths: manifestPaths,
      files: [{ path, content, sha256: fileSha }],
      artifact: { artifact_id: "ARTIFACT-1", file_checksums: { [path]: fileSha } },
      context: { base_sha: "b".repeat(40), review_commit_sha: "c".repeat(40), manifest_sha: "M-1", manifest_paths: [path] }
    };
    const job = { task_id: "T-REV", request_id: "REQ-1", correlation_id: "CORR-1", payload: { changed_paths: manifestPaths } };
    const tools = createReviewerForgeTools({
      fileService,
      projectRoot: root,
      job,
      reviewer: { agent_id: "rev-1", provider: "openai" },
      codeCache: { read: async () => ({ path, content, sha256: fileSha, index_status: "unavailable", code_index: { path, symbols: [] } }) },
      ticketEvidence,
      captureReviewEnvironment: async () => ({ files: [], sha256: "env" }),
      materializeReview: async () => ({ path: root, temp_dir: root, assertTicketSource: async () => {}, assertEnvironment: async () => {}, cleanup: async () => {} }),
      runReviewCommand: async () => ({ exit_code: 0, stdout: "1 passing", stderr: "" })
    });

    assert.equal(tools.context.max_output_bytes, 288_000);
    assert.equal(Boolean(tools.registry.review_diff), true);
    assert.equal(Boolean(tools.registry.run_review_check), true);

    const metadata = await tools.registry.read_file.execute({ path });
    assert.equal(metadata.index_status, "extracted");
    assert.equal(metadata.symbol_map.some((sym) => sym.name === "computeTotal"), true);

    const symRead = await tools.registry.read_file.execute({ path, symbol: "computeTotal" });
    assert.match(symRead.content, /export function computeTotal/);

    const check1 = await tools.registry.run_review_check.execute({ type: "test", command: "node --test backend/tests/unit/reviewer-forge-tools.test.js" });
    assert.equal(check1.status, "passed");
    const check2 = await tools.registry.run_review_check.execute({ type: "test", command: "node --test backend/tests/unit/reviewer-forge-tools.test.js" });
    assert.equal(check2.status, "passed");
    await assert.rejects(
      () => tools.registry.run_review_check.execute({ type: "test", command: "node --test backend/tests/unit/reviewer-forge-tools.test.js" }),
      { code: "REVIEW_CHECK_BUDGET" }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("O6: Reviewer can approve with minor findings marked defer_to_backlog: true when gate is on, enqueuing deduplicated review.backlog items", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-o6-"));
  try {
    const fileService = createFileService({ projectRoot: root });
    const contexts = createTicketExecutionContextStore({ fileService, projectId: "P-1", projectRoot: root });
    await contexts.create({ taskId: "T-O6", supervisorId: "SUP-1", baseSha: "a".repeat(40) });
    await contexts.update("T-O6", 1, { state: "verified", verification_artifact_id: "ARTIFACT-O6", review_commit_sha: "b".repeat(40) });
    const findingsStore = createTicketReviewFindingsStore({ taskId: "T-O6", fileService, executionContexts: contexts });

    const minorFinding = {
      failure: "Variable naming could be clearer", acceptance_criterion: "AC-1",
      minimum_change_scope: "Rename temp variable in helper", evidence_refs: ["src/a.js:10"],
      severity: "minor", defer_to_backlog: true
    };
    const parsed = parseReviewVerdict(JSON.stringify({ verdict: "approved", findings: [minorFinding], adjudications: [] }), { strict: true, paths: ["src/a.js"], artifactId: "ARTIFACT-O6" });
    assert.equal(parsed.verdict, "approved");

    assert.throws(() => parseReviewVerdict(JSON.stringify({
      verdict: "approved", findings: [{ ...minorFinding, severity: "major" }], adjudications: []
    }), { strict: true, paths: ["src/a.js"] }), { code: "REVIEW_VERDICT_INVALID" });

    const recorded = await findingsStore.recordReview({
      verdict: "approved", findings: parsed.findings, adjudications: [],
      artifactId: "ARTIFACT-O6", commitSha: "b".repeat(40), reviewerId: "rev-1"
    });
    assert.equal(recorded.findings.length, 1);
    assert.equal(recorded.findings[0].status, "deferred_to_backlog");
    assert.equal(await findingsStore.assertResolved(), true);

    const backlog = [];
    const queueStore = {
      list: async (q) => q === "review.backlog" ? backlog : [],
      save: async (q, item) => { if (q === "review.backlog") backlog.push(item); }
    };
    const job = {
      id: "JOB-1", task_id: "T-O6", project_id: "P-1", supervisor_id: "SUP-1", request_id: "REQ-1", correlation_id: "CORR-1",
      job_key: `sha256:${"f".repeat(64)}`, decision_identity: { source_revision: "rev-1" }, review_policy: { gate: "on" },
      payload: { ticket: { title: "O6 Ticket" }, changed_paths: ["src/a.js"] },
      review_result: { type: "review.approved", payload: { verdict: "approved", findings: recorded.findings.map((f) => ({ ...f.finding, finding_id: f.finding_id })) } }
    };
    await publishAutomaticReviewOutcome({
      job, queueStore, queue: { ack: async () => {} }, eventBus: { publish: async () => {} },
      checkpoints: {}, repairCount: async () => 0, locked: async (fn) => fn()
    });
    assert.equal(backlog.length, 1);
    assert.equal(backlog[0].finding_id, "REV-1");
    assert.equal(backlog[0].priority, "low");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
