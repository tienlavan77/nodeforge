/** Verifies recovery delivers complete receipt references and retained failure
 * identities to coordinating agents before they decide the next ticket action.
 * Missing current verification and a not-started review must not hide existing
 * diagnostics or imply that an independent Reviewer report already exists. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { buildBlockerTicketProgress } from "../../src/modules/supervisor/blocker/blocker-ticket-progress.js";
import { createBlockerPromptContext } from "../../src/modules/supervisor/blocker/blocker-prompt-context.js";
import { blockerRecoveryTools } from "../../src/modules/supervisor/blocker/blocker-recovery-tools.js";
import { createBlockerVerificationDelivery } from "../../src/modules/supervisor/blocker/blocker-verification-delivery.js";

/** Reproduces a failed committed verification followed by a new coding source
 * context, without changing the original receipts or creating review evidence. */
async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), "nf-evidence-delivery-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const context = { task_id: "TASK", project_id: "P", source_revision: "CURRENT", review_commit_sha: null, version: 2 };
  const checkpoint = { last_completed_turn: 118, verification_wait: { job_id: "VERIFY-OLD", task_id: "TASK",
    commit_sha: "COMMIT-OLD", source_revision: "OLD", status: "failed" } };
  const job = { id: "J", stage: "sprint_leader", history: [], request: { project_id: "P", task_id: "TASK",
    payload: { execution_id: "E" }, execution_context: context, ticket: { id: "TASK", acceptance_criteria: ["Preserve approved read behavior."] } } };
  const fileService = createFileService({ projectRoot });
  const workspace = { projectRoot, fileService, executionContexts: { load: async () => context },
    reviewFindings: { load: async () => ({ task_id: "TASK", findings: [], adjudications: [] }) },
    changeLedger: { snapshot: async () => ({ entries: {} }) } };
  const verification = { task_id: "TASK", job_id: "VERIFY-OLD", status: "failed", artifact_id: "ARTIFACT-OLD", attempt: 1,
    source_revision: "OLD", commit_sha: "COMMIT-OLD", started_at: "2026-10-24T12:00:00Z", error: { code: "VERIFY_BASELINE_UNAVAILABLE" } };
  const artifact = { task_id: "TASK", project_id: "P", artifact_id: "ARTIFACT-OLD", source_revision: "OLD", commit_sha: "COMMIT-OLD", status: "failed",
    commands: [{ kind: "backend_tests", argv: ["node", "--test", "supplemental.test.js"], exit_code: 1,
      scope: "supplemental", disposition: "unattributed_failure", stdout_redacted: "The unchanged assertion expects 80 physical lines." }] };
  /** Persists immutable-style records under production receipt names, including
   * deliberate foreign or mismatched records for isolation regression coverage. */
  async function save(directory, value, name = value.job_id ?? value.artifact_id) {
    const path = `.forge/runtime/ticket-verification/TASK/${directory}/${name}.json`;
    await mkdir(dirname(join(projectRoot, path)), { recursive: true });
    await writeFile(join(projectRoot, path), JSON.stringify(value, null, 2));
    return path;
  }
  const jobPath = await save("jobs", verification), artifactPath = await save("artifacts", artifact);
  return { projectRoot, context, checkpoint, job, workspace, verification, artifact, save, jobPath, artifactPath,
    build: () => buildBlockerTicketProgress({ job, checkpoint, workspace, reviewCheckpoint: null }) };
}

test("SL receives the failed retained artifact without baseline after current source changes, before Reviewer starts", async (t) => {
  const f = await fixture(t), progress = await f.build();
  assert.equal(progress.verification.status, "missing");
  assert.equal(progress.verification.job, null);
  assert.equal(progress.verification.retained_attempt.job.job_id, "VERIFY-OLD");
  assert.equal(progress.verification.retained_attempt.artifact.artifact_id, "ARTIFACT-OLD");
  assert.equal(progress.verification.baseline_evidence.status, "not_recorded");
  assert.equal(progress.verification.historical_artifacts[0].commands[0].exit_code, 1);
  assert.equal(progress.verification.historical_artifacts[0].diagnostic_only, true);
  assert.equal(progress.review_status.status, "not_started");
  assert.equal(progress.review_access, null);
  assert(progress.criteria.every((criterion) => criterion.verification === "unverified"));
  assert.equal(progress.artifact_id, null);
  const assigned = { ...f.job, ticket_progress: progress };
  const prepared = await createBlockerPromptContext({ job: assigned, projectRoot: f.projectRoot });
  const line = prepared.summary.split("\n").find((entry) => entry.startsWith("NODE EVIDENCE DELIVERY: "));
  const delivery = JSON.parse(line.slice("NODE EVIDENCE DELIVERY: ".length));
  assert.equal(delivery.retained_attempt.job_id, "VERIFY-OLD");
  assert.equal(delivery.retained_attempt.artifact_ref, f.artifactPath);
  assert.equal(delivery.review_status.status, "not_started");
  assert.equal(prepared.minimalJob.ticket_progress.review_status.status, "not_started");
  // Policy (a): the agent-facing prompt carries the bounded-read convention as guidance
  // only; Node enforces the existing tool ceilings (250 lines / 200 KB), not a hard 80/8 KB gate.
  assert.match(prepared.summary, /bounded windows of at most 80 lines and 8 KB/);
  assert.match(JSON.stringify(prepared.job), /bounded windows of at most 80 lines and 8 KB/);
  for (const role of ["sprint_leader", "architecture_manager"]) {
    const tools = blockerRecoveryTools({ projectRoot: f.projectRoot, fileService: f.workspace.fileService,
      profile: { agent_id: "A", role }, task_id: "TASK", job: { ...assigned, prompt_context_refs: prepared.refs } });
    const original = JSON.parse((await tools.registry.read_file.execute({ path: f.jobPath, offset: 1, limit: 80 })).content);
    assert.equal(original.error.code, "VERIFY_BASELINE_UNAVAILABLE");
    const result = await tools.registry.read_file.execute({ path: f.artifactPath, offset: 1, limit: 80 });
    assert.match(result.content, /80 physical lines/);
    assert.equal(result.sha256, progress.verification.retained_attempt.artifact.receipt_sha256);
  }
});

test("complete receipt inventory stays readable beyond bounded inline lists and prioritizes the checkpoint attempt", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 12; index += 1) {
    await f.save("jobs", { ...f.verification, job_id: `VERIFY-${index}`, artifact_id: `ARTIFACT-${index}`,
      started_at: "2026-10-24T13:00:00Z" });
    await f.save("artifacts", { ...f.artifact, artifact_id: `ARTIFACT-${index}` });
  }
  await f.save("jobs", { ...f.verification, job_id: "VERIFY-FOREIGN", project_id: "OTHER" });
  await f.save("artifacts", { ...f.artifact, artifact_id: "ARTIFACT-FOREIGN", project_id: "OTHER" });
  await f.save("jobs", { ...f.verification, task_id: "OTHER", job_id: "VERIFY-TASK" });
  await f.save("jobs", { ...f.verification, job_id: "VERIFY-MISMATCH" }, "VERIFY-WRONG-NAME");
  const progress = await f.build(), evidence = progress.verification;
  assert.equal(evidence.historical_jobs.length, 8);
  assert.equal(evidence.historical_artifacts.length, 8);
  assert.equal(evidence.historical_jobs[0].job_id, "VERIFY-OLD");
  assert.equal(evidence.historical_artifacts[0].artifact_id, "ARTIFACT-OLD");
  assert.equal(evidence.receipt_index.length, 26);
  assert(!evidence.receipt_index.some((entry) => /FOREIGN|TASK|MISMATCH/.test(entry.job_id ?? entry.artifact_id)));
  const omitted = evidence.receipt_index.find((entry) => entry.type === "artifacts"
    && !evidence.historical_artifacts.some((artifact) => artifact.artifact_id === entry.artifact_id));
  assert(omitted);
  const tools = blockerRecoveryTools({ projectRoot: f.projectRoot, fileService: f.workspace.fileService,
    profile: { agent_id: "SL", role: "sprint_leader" }, task_id: "TASK", job: { ...f.job, ticket_progress: progress } });
  assert.equal((await tools.registry.read_file.execute({ path: omitted.evidence_ref })).sha256, omitted.receipt_sha256);
  await f.save("artifacts", { ...f.artifact, artifact_id: omitted.artifact_id, status: "passed" });
  await assert.rejects(tools.registry.read_file.execute({ path: omitted.evidence_ref }), { code: "VERIFY_SOURCE_STALE" });
});

test("wrong checkpoint source or commit cannot relabel a different historical attempt as the retained verification", async (t) => {
  for (const patch of [{ source_revision: "OTHER" }, { commit_sha: "OTHER" }]) {
    const f = await fixture(t);
    Object.assign(f.checkpoint.verification_wait, patch);
    const progress = await f.build();
    assert.equal(progress.verification.retained_attempt.status, "not_recorded");
    assert.equal(progress.verification.retained_attempt.job, null);
    assert.equal(progress.verification.retained_attempt.artifact, null);
    assert.equal(progress.artifact_id, null);
  }
});

test("151KB receipts pass discovery, delivery and both agent read tools with identical hashes and paged output", async (t) => {
  const f = await fixture(t);
  const artifact = { ...f.artifact, output: Array.from({ length: 500 }, (_, index) => `line-${index}: ${"x".repeat(300)}`) };
  await f.save("artifacts", artifact);
  Object.assign(f.job, { outcome_reason: "technical_reconciliation_waiting_for_evidence",
    resolution: { reconciliation: { kind: "tooling", waiting_for: [{ owner: "external", operation: "inspect" }] } } });
  const refresh = createBlockerVerificationDelivery({ inspect: async () => ({ workspace: f.workspace, checkpoint: f.checkpoint }) });
  assert.equal(await refresh(f.job), true);
  assert.equal(f.job.ticket_progress.verification.delivery.status, "readable");
  const receipt = f.job.ticket_progress.verification.receipt_index.find((entry) => entry.artifact_id === "ARTIFACT-OLD");
  for (const role of ["sprint_leader", "architecture_manager"]) {
    const tools = blockerRecoveryTools({ projectRoot: f.projectRoot, fileService: f.workspace.fileService,
      profile: { agent_id: "A", role }, task_id: "TASK", job: f.job });
    const read = await tools.registry.read_file.execute({ path: f.artifactPath, offset: 30, limit: 10 });
    const lines = await tools.registry.read_lines.execute({ path: f.artifactPath, start_line: 30, end_line: 39 });
    assert.equal(read.sha256, receipt.receipt_sha256);
    assert.equal(lines.sha256, receipt.receipt_sha256);
    assert(read.size_bytes > 151_000);
    assert(read.truncated);
    assert(read.content.split("\n").length <= 10);
    assert(lines.stdout.split("\n").length <= 11);
    await f.workspace.fileService.atomicWrite({ path: "backend/src/large.js", content: "x".repeat(130_000), replace: true });
    await assert.rejects(tools.registry.read_file.execute({ path: "backend/src/large.js" }), { code: "FILE_TOO_LARGE" });
  }
  await f.save("artifacts", { ...artifact, status: "passed" });
  const tools = blockerRecoveryTools({ projectRoot: f.projectRoot, fileService: f.workspace.fileService,
    profile: { agent_id: "A", role: "sprint_leader" }, task_id: "TASK", job: f.job });
  await assert.rejects(tools.registry.read_file.execute({ path: f.artifactPath }), { code: "VERIFY_SOURCE_STALE" });
});
