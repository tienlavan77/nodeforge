// Exercises complete Node-owned evidence delivery, including historical failures, absent baselines and safe checkpoint wake-up.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { readBlockerVerificationEvidence } from "../../src/modules/supervisor/blocker-verification-evidence.js";
import { blockerRecoveryTools } from "../../src/modules/supervisor/blocker-recovery-tools.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createBlockerVerificationDelivery } from "../../src/modules/supervisor/blocker-verification-delivery.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { BLOCKER_RECEIPT_MAX_BYTES } from "../../src/modules/supervisor/blocker-evidence-limits.js";

// Persists current and older-source receipts without a verification job to reproduce the stopped pre-commit ticket.
async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), "nf-verification-history-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const context = { task_id: "TASK", project_id: "P", source_revision: "CURRENT", review_commit_sha: null, version: 1 };
  const wait = { action: "reconciliation_required", summary: "Supply the retained check evidence.", guidance: "Compare assertions before attributing the security failure.",
    reconciliation: { kind: "tooling", prerequisite: "Readable historical check and baseline inventory.", completed_checks: ["Current check passes."], next_check: "Read recorded failures.",
      waiting_for: [{ owner: "external", operation: "inspect", question: "Node must supply CHECK-OLD and any recorded baseline." }] } };
  const job = { id: "J", stage: "sprint_leader", status: "reconciliation_required", outcome_reason: "technical_reconciliation_waiting_for_evidence", history: [], resolution: wait,
    request: { task_id: "TASK", project_id: "P", payload: { execution_id: "EXEC" }, ticket: {} }, ticket_progress: { verification: { status: "missing", checks: [] } } };
  const fileService = createFileService({ projectRoot });
  const workspace = { projectRoot, fileService, executionContexts: { load: async () => context } };
  // Writes an immutable fixture receipt into the same namespace used by production verification.
  async function save(directory, receipt, name = receipt.check_id ?? receipt.artifact_id) {
    const path = `.forge/runtime/ticket-verification/TASK/${directory}/${name}.json`;
    await mkdir(dirname(join(projectRoot, path)), { recursive: true });
    await writeFile(join(projectRoot, path), JSON.stringify(receipt, null, 2));
    return path;
  }
  const current = { check_id: "CHECK-CURRENT", task_id: "TASK", source_revision: "CURRENT", commit_sha: null, pre_commit: true,
    status: "passed", command: "node --test current.test.js", exit_code: 0, stdout: "41 passed", environment: { sha256: "ENV-CURRENT" } };
  const old = { ...current, check_id: "CHECK-OLD", source_revision: "OLDER", status: "failed", exit_code: 1,
    stdout: "5 security assertions failed", command: "node --test security.test.js", environment: { sha256: "ENV-OLD" } };
  const currentPath = await save("checks", current), oldPath = await save("checks", old);
  // Builds both provider adapters' common read tools with the exact fresh Node evidence snapshot.
  const tools = (role, verification) => blockerRecoveryTools({ projectRoot, fileService, profile: { role, agent_id: "A" }, task_id: "TASK", correlation_id: "C",
    job: { ...job, ticket_progress: { verification } } });
  return { context, job, workspace, save, current, old, oldPath, currentPath, tools, read: () => readBlockerVerificationEvidence({ job, workspace, context }) };
}

test("historical check stays separate from current acceptance and is fully readable by SL and AM", async (t) => {
  const f = await fixture(t);
  const evidence = await f.read();
  assert.equal(evidence.status, "missing");
  assert.deepEqual(evidence.checks.map((entry) => entry.check_id), ["CHECK-CURRENT"]);
  const old = evidence.historical_checks[0];
  assert.equal(old.check_id, "CHECK-OLD"); assert.equal(old.provenance, "historical_ticket_source"); assert.equal(old.diagnostic_only, true);
  assert.equal(old.environment.sha256, "ENV-OLD");
  assert.equal(evidence.baseline_evidence.status, "not_recorded");
  assert.deepEqual(evidence.baseline_evidence.searched, { checks: 2, artifacts: 0 });
  for (const role of ["sprint_leader", "architecture_manager"]) {
    const tools = f.tools(role, evidence);
    const result = await tools.registry.read_file.execute({ path: f.oldPath, offset: 1, limit: 80 });
    assert.match(result.content, /5 security assertions failed/);
    assert.match((await tools.registry.read_lines.execute({ path: f.oldPath, start_line: 1, end_line: 80 })).stdout, /5 security assertions failed/);
    assert.equal((await validateBlockerDisposition({ action: "reconciliation_required", summary: "Historical failure inspected.", guidance: "Compare source and environment before assigning responsibility.",
      evidence: [{ path: f.oldPath, sha256: result.sha256.slice(7) }] }, { job: { ...f.job, stage: role, ticket_progress: { verification: evidence } },
      projectRoot: f.workspace.projectRoot, fileService: f.workspace.fileService })).action, "reconciliation_required");
  }
  assert.equal(evidence.artifact_id, undefined);
});

test("historical grants reject changed bytes, foreign identities, unissued receipts and symlinks", async (t) => {
  const f = await fixture(t), evidence = await f.read();
  const tools = f.tools("sprint_leader", evidence);
  for (const delta of [{ stdout: "replacement output" }, { source_revision: "REPLACED" }, { task_id: "OTHER" }, { project_id: "OTHER" }]) {
    await f.save("checks", { ...f.old, ...delta });
    await assert.rejects(tools.registry.read_file.execute({ path: f.oldPath, offset: 1, limit: 80 }), { code: "VERIFY_SOURCE_STALE" });
  }
  const otherPath = await f.save("checks", { ...f.old, check_id: "CHECK-UNISSUED" });
  await assert.rejects(tools.registry.read_file.execute({ path: otherPath }), { code: "FILE_ROLE_FORBIDDEN" });
  await rm(join(f.workspace.projectRoot, f.oldPath));
  await symlink(join(f.workspace.projectRoot, f.currentPath), join(f.workspace.projectRoot, f.oldPath));
  await assert.rejects(tools.registry.read_file.execute({ path: f.oldPath }), { code: "FILE_ROLE_FORBIDDEN" });
});

test("baseline inventory preserves actual command/environment identity and explicitly diagnoses missing baseline", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.read()).baseline_evidence.status, "not_recorded");
  const artifact = { artifact_id: "ARTIFACT-OLD", task_id: "TASK", project_id: "P", source_revision: "OLDER", commit_sha: "COMMIT-OLD", status: "failed",
    environment: { sha256: "ENV-OLD" }, commands: [{ argv: ["node", "--test", "security.test.js"], exit_code: 1,
      baseline: { commit_sha: "BASE", environment_sha256: "ENV-BASE", exit_code: 1, failure_sha256: "FAILURE", stdout_redacted: "baseline assertion cause" } }] };
  const path = await f.save("artifacts", artifact);
  const evidence = await f.read();
  assert.equal(evidence.baseline_evidence.status, "recorded");
  assert.equal(evidence.baseline_evidence.receipts[0].commands[0].baseline.environment_sha256, "ENV-BASE");
  assert.match(evidence.baseline_evidence.receipts[0].commands[0].baseline.stdout_redacted, /assertion cause/);
  assert.equal(evidence.historical_artifacts[0].diagnostic_only, true);
  assert.match((await f.tools("sprint_leader", evidence).registry.read_file.execute({ path, offset: 1, limit: 80 })).content, /baseline assertion cause/);
  assert.equal(evidence.job, null);
});

test("history selection pins requested failure, bounds inline output and excludes foreign/misnamed records", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 12; index += 1) await f.save("checks", { ...f.old, check_id: `CHECK-${index}`, completed_at: `2026-10-23T04:${String(index).padStart(2, "0")}:00Z` });
  await f.save("checks", { ...f.old, check_id: "CHECK-FOREIGN", project_id: "OTHER" });
  await f.save("checks", { ...f.old, check_id: "CHECK-WRONG" }, "CHECK-MISNAMED");
  await f.save("checks", { ...f.old, stdout: `START${"x".repeat(20000)}END` });
  const evidence = await f.read();
  assert.equal(evidence.historical_checks.length, 8);
  assert.equal(evidence.historical_checks[0].check_id, "CHECK-OLD");
  assert.match(evidence.historical_checks[0].stdout, /^START/); assert.match(evidence.historical_checks[0].stdout, /END$/);
  assert(evidence.historical_checks[0].stdout.length < 4100);
  assert.equal(evidence.baseline_evidence.searched.checks, 14);
});

test("readable delivery wakes SL once across restart, preserves denial and rejects stale authority", async (t) => {
  const f = await fixture(t);
  f.job.execution_admission = { decision: { verdict: "deny" } };
  const original = structuredClone(f.job);
  const options = { inspect: async () => ({ workspace: f.workspace }), clock: () => 1 };
  assert.equal(await createBlockerVerificationDelivery(options)(f.job), true);
  assert.equal(f.job.ticket_progress.verification.delivery.status, "readable");
  assert.equal(f.job.ticket_progress.verification.baseline_evidence.status, "not_recorded");
  assert.deepEqual(f.job.execution_admission, original.execution_admission);
  assert.deepEqual(f.job.request, original.request);
  f.job.resolution = original.resolution;
  assert.equal(await createBlockerVerificationDelivery(options)(f.job), false);
  const stale = structuredClone(original);
  assert.equal(await createBlockerVerificationDelivery({ inspect: async () => null })(stale), false);
  assert.deepEqual(stale, original);
});

test("delivery does not wake SL if source moves while receipt readability is being checked", async (t) => {
  const f = await fixture(t), original = structuredClone(f.job);
  let loads = 0;
  f.workspace.executionContexts.load = async () => ++loads >= 3 ? { ...f.context, version: 2 } : f.context;
  assert.equal(await createBlockerVerificationDelivery({ inspect: async () => ({ workspace: f.workspace }) })(f.job), false);
  assert.deepEqual(f.job, original);
});

test("delivery never marks receipts above the shared storage budget as readable", async (t) => {
  const f = await fixture(t), original = structuredClone(f.job);
  await f.save("checks", { ...f.old, stdout: "x".repeat(BLOCKER_RECEIPT_MAX_BYTES) });
  await assert.rejects(createBlockerVerificationDelivery({ inspect: async () => ({ workspace: f.workspace }) })(f.job), /(?:large|limit|bytes)/i);
  assert.deepEqual(f.job, original);
});

test("parked Node receipt wait supplies evidence to AM before SL and Stop prevents the same recovery", async () => {
  for (const stopped of [false, true]) {
    const f = await blockerRecoveryFixture();
    try {
      await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
      const before = await f.base.checkpoints.load("TASK");
      const context = await f.base.workspace.executionContexts.load("TASK");
      const path = ".forge/runtime/ticket-verification/TASK/checks/CHECK-HISTORY.json";
      await f.base.fileService.atomicWrite({ path, content: JSON.stringify({ check_id: "CHECK-HISTORY", task_id: "TASK", source_revision: "OLD-SOURCE", commit_sha: "OLD-COMMIT", status: "failed", exit_code: 1 }), replace: false });
      if (stopped) await f.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
      await f.base.store.withLock("blocker.recovery", async () => {
        const ledger = await f.ledger();
        Object.assign(ledger.jobs[0], { stage: "sprint_leader", status: "reconciliation_required", outcome_reason: "technical_reconciliation_waiting_for_evidence",
          resolution: { action: "reconciliation_required", reconciliation: { kind: "tooling", waiting_for: [{ owner: "external", operation: "inspect", question: "Provide CHECK-HISTORY receipt and baseline evidence." }] } } });
        await f.base.store.save("blocker.recovery", ledger);
      });
      f.recreate(); await f.recovery.tick();
      assert.deepEqual(f.calls, stopped ? [] : ["architecture_manager"]);
      assert.equal(f.base.invocations, 1);
      assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, before.last_completed_turn);
      assert.equal((await f.base.workspace.executionContexts.load("TASK")).source_revision, context.source_revision);
      if (!stopped) assert.equal((await f.ledger()).jobs[0].ticket_progress.verification.historical_checks[0].check_id, "CHECK-HISTORY");
    } finally { await f.close(); }
  }
});
