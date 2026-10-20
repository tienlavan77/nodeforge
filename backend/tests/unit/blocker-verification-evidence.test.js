// Verifies recovery receives scoped runtime evidence without promoting failed or historical checks to acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readBlockerVerificationEvidence } from "../../src/modules/supervisor/blocker-verification-evidence.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

// Creates immutable evidence fixtures for independent source and project isolation checks.
async function evidenceFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "nf-blocker-verification-"));
  const context = { task_id: "TASK", project_id: "P", source_revision: "SOURCE", review_commit_sha: "COMMIT", base_sha: "BASE", manifest_sha: "MANIFEST", version: 1 };
  const job = { request: { task_id: "TASK", project_id: "P" } };
  const workspace = { projectRoot, executionContexts: { load: async () => context } };
  // Persists only the selected ticket's fixture records under its protected runtime namespace.
  async function save(path, value) {
    const target = join(projectRoot, ".forge/runtime/ticket-verification/TASK", path);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(value));
  }
  const verify = { job_id: "VERIFY-A", task_id: "TASK", status: "failed", attempt: 1, commit_sha: "COMMIT", source_revision: "SOURCE",
    runner_revision: "OLD-RUNNER", artifact_id: "ARTIFACT-A", error: { code: "VERIFY_COMMAND_FAILED" }, started_at: "2026-10-19T10:00:00Z" };
  const artifact = { artifact_id: "ARTIFACT-A", task_id: "TASK", project_id: "P", commit_sha: "COMMIT", source_revision: "SOURCE", base_sha: "BASE", manifest_sha: "MANIFEST", status: "failed",
    commands: [{ kind: "test", argv: ["node", "--test", "backend/cli.test.js"], exit_code: 1, stderr_redacted: "ERR_MODULE_NOT_FOUND missing-dependency.js" }] };
  return { context, job, workspace, save, verify, artifact, read: () => readBlockerVerificationEvidence({ job, workspace, context }), close: () => rm(projectRoot, { recursive: true, force: true }) };
}

test("retained failure exposes job identity and command diagnostic across runner versions without acceptance", async () => {
  const f = await evidenceFixture();
  try {
    await f.save("jobs/VERIFY-A.json", f.verify); await f.save("artifacts/ARTIFACT-A.json", f.artifact);
    const evidence = await f.read();
    assert.equal(evidence.status, "observed"); assert.equal(evidence.job.status, "failed");
    assert.equal(evidence.job.runner_revision, "OLD-RUNNER");
    assert.match(evidence.diagnostic.commands[0].stderr_redacted, /ERR_MODULE_NOT_FOUND/);
    assert.equal(f.context.verification_artifact_id, undefined);
    assert.equal(evidence.ready_for_review, undefined);
  } finally { await f.close(); }
});

test("pending verification refreshes to its terminal result without a polling tool or cached snapshot", async () => {
  const f = await evidenceFixture();
  try {
    await f.save("jobs/VERIFY-A.json", { ...f.verify, status: "running", artifact_id: undefined });
    assert.equal((await f.read()).job.status, "running");
    await f.save("jobs/VERIFY-A.json", f.verify); await f.save("artifacts/ARTIFACT-A.json", f.artifact);
    assert.equal((await f.read()).job.status, "failed");
  } finally { await f.close(); }
});

test("wrong task, project, source and immutable artifact identities cannot supply recovery proof", async () => {
  const f = await evidenceFixture();
  try {
    for (const patch of [{ task_id: "OTHER" }, { source_revision: "OTHER" }, { commit_sha: "OTHER" }]) {
      await f.save("jobs/VERIFY-A.json", { ...f.verify, ...patch });
      assert.equal((await f.read()).status, "missing");
    }
    await f.save("jobs/VERIFY-A.json", f.verify);
    await f.save("artifacts/ARTIFACT-A.json", { ...f.artifact, project_id: "OTHER" });
    assert.equal((await f.read()).diagnostic.reason, "VERIFY_SOURCE_STALE");
    f.job.request.project_id = "OTHER";
    assert.equal((await f.read()).status, "unavailable");
  } finally { await f.close(); }
});

test("focused check evidence excludes other sources and bounds retained output", async () => {
  const f = await evidenceFixture();
  try {
    const check = { check_id: "CHECK-A", task_id: "TASK", source_revision: "SOURCE", commit_sha: "COMMIT", status: "failed", exit_code: 1,
      completed_at: "2026-10-19T10:00:00Z", stderr: `START${"x".repeat(20000)}END` };
    await f.save("checks/CHECK-A.json", check);
    await f.save("checks/CHECK-B.json", { ...check, check_id: "CHECK-B", source_revision: "OTHER" });
    const evidence = await f.read();
    assert.equal(evidence.checks.length, 1);
    assert.match(evidence.checks[0].stderr, /^START/); assert.match(evidence.checks[0].stderr, /END$/);
    assert(evidence.checks[0].stderr.length < 4100);
  } finally { await f.close(); }
});

test("context changes during collection return unavailable rather than stale recovery evidence", async () => {
  const f = await evidenceFixture();
  try {
    f.workspace.executionContexts.load = async () => ({ ...f.context, version: 2 });
    assert.equal((await f.read()).status, "unavailable");
  } finally { await f.close(); }
});

test("AM external-evidence answer reaches SL across restart with Node verification diagnostics", async () => {
  let f;
  f = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
    if (!job.architecture_response && job.stage === "sprint_leader") return { action: "architecture_required", summary: "Clarify verification recovery." };
    if (job.stage === "architecture_manager") return { action: "reconciliation_required", summary: "No Architecture change; SL needs terminal verification evidence.", guidance: "Return to SL to consume the recorded CLI failure and choose in-scope recovery.",
      evidence: [f.evidence], reconciliation: { kind: "tooling", prerequisite: "Read the retained verification result.", completed_checks: ["Contract unchanged."], next_check: "SL consumes Node job evidence.",
        waiting_for: [{ owner: "external", operation: "inspect", question: "Supply the verification terminal result." }] } };
    assert.equal(job.stage, "sprint_leader");
    assert.equal(job.ticket_progress.verification.job.status, "failed");
    assert.match(job.ticket_progress.verification.diagnostic.commands[0].stderr_redacted, /ERR_MODULE_NOT_FOUND/);
    assert(job.ticket_progress.criteria.every((entry) => entry.verification === "unverified"));
    return { ...resolution, technical_result: { findings: ["Node supplied failed CLI receipt; no Architecture change."], implementation_steps: ["Repair missing source dependency within existing authority."],
      verification_steps: ["Reverify complete committed source after repair."], admission: { status: "within_existing_permissions", rationale: "Existing tool checks remain mandatory." } } };
  } });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const context = await f.base.workspace.executionContexts.load("TASK");
    const root = ".forge/runtime/ticket-verification/TASK";
    await f.base.fileService.atomicWrite({ path: `${root}/jobs/VERIFY-A.json`, content: JSON.stringify({ job_id: "VERIFY-A", task_id: "TASK", status: "failed", attempt: 1,
      commit_sha: context.review_commit_sha, source_revision: context.source_revision, artifact_id: "ARTIFACT-A", error: { code: "VERIFY_COMMAND_FAILED" } }), replace: false });
    await f.base.fileService.atomicWrite({ path: `${root}/artifacts/ARTIFACT-A.json`, content: JSON.stringify({ artifact_id: "ARTIFACT-A", ...context,
      commit_sha: context.review_commit_sha, status: "failed", commands: [{ kind: "test", exit_code: 1, stderr_redacted: "ERR_MODULE_NOT_FOUND missing dependency" }] }), replace: false });
    await f.recovery.tick(); await f.recovery.tick();
    const before = (await f.ledger()).jobs[0];
    assert.equal(before.stage, "sprint_leader", JSON.stringify(before.validation_feedback)); assert.equal(before.status, "pending");
    assert.equal(f.base.invocations, 1);
    await f.recreate().tick();
    assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
    assert.equal((await f.ledger()).jobs[0].status, "resume_pending");
    assert.equal(f.base.invocations, 1);
  } finally { await f.close(); }
});
