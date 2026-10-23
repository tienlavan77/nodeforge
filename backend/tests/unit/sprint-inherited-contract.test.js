// Reproduces downstream contract validation after completed Sprint tickets advance the shared baseline.
import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../fixtures/ticket-contract-source-fixture.js";
import { findIntegratedTicketSource } from "../../src/modules/supervisor/ticket-integrated-source.js";
import { buildBlockerTicketProgress } from "../../src/modules/supervisor/blocker-ticket-progress.js";
import { createBlockerSourceResume } from "../../src/modules/supervisor/blocker-source-resume.js";
import { preflightBlockerContract } from "../../src/modules/supervisor/blocker-contract-preflight.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";

// Advances the downstream workspace to reviewed predecessor bytes, retaining the old approval checksum.
async function inheritedFixture(t) {
  const f = await fixture(t);
  await f.files.atomicWrite({ path: f.path, content: f.updated, replace: true });
  await f.git.run(["add", "--", f.path]);
  await f.git.run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "completed predecessor"]);
  const commit = (await f.git.run(["rev-parse", "HEAD"])).trim();
  const prior = { task_id: "PRIOR", project_id: "P", state: "terminal", review_commit_sha: commit,
    verification_artifact_id: "A", manifest_sha: "M", source_revision: "S" };
  f.context.base_sha = commit;
  f.workspace.base_commit = commit;
  f.workspace.executionContexts.load = async (taskId) => taskId === "PRIOR" ? prior : f.context;
  f.workspace.findIntegratedSource = (path, sha256, targetSha256, baselineCommit) => findIntegratedTicketSource({
    path, sha256, targetSha256, baselineCommit, taskId: "T", projectId: "P", fileService: f.files, executionContexts: f.workspace.executionContexts, rootGit: f.git });
  await f.files.atomicWrite({ path: ".forge/runtime/ticket-integrations/PRIOR.json", content: JSON.stringify({
    task_id: "PRIOR", status: "completed", workspace_mode: "root-only", reviewed_commit: commit, commit,
    artifact_id: "A", manifest_sha: "M", source_revision: "S"
  }), replace: false });
  const basis = { project_id: "P", sprint_id: "S", plan_id: "PLAN", plan_revision: 1, plan_path: "plan.json", plan_sha256: "a".repeat(64), version: 1 };
  const status = { project_id: "P", status: "done", details: { execution_id: "E-PRIOR", execution_basis: basis } };
  f.request.ticket.dependencies = ["PRIOR"];
  f.request.payload.dependency_expectations = [{ ticket_id: "PRIOR", execution_id: "E-PRIOR", execution_basis: basis, sprint_basis: basis }];
  const services = { sprintRegistry: { get: () => ({ ...basis, status: "ready" }) }, ticketStatusStore: { get: () => status } };
  const job = { id: "J", request: f.request, history: [], outcome_reason: "technical_reconciliation_waiting_for_evidence",
    resolution: { reconciliation: { kind: "source_revision" } }, ticket_progress: { contract_source: [{ status: "blocked" }] } };
  const authority = { workspace: f.workspace, checkpoint: f.checkpoint() };
  return { ...f, job, authority, services, prior, status };
}

test("downstream baseline inherits reviewed source while retaining exact historical approval", async (t) => {
  const f = await inheritedFixture(t);
  const frozen = JSON.stringify(f.ref);
  const progress = await buildBlockerTicketProgress({ job: f.job, ...f.authority, ...f.services });
  const receipt = progress.contract_source[0];
  assert.equal(receipt.status, "validated");
  assert.equal(receipt.provenance, "integrated_project_changes");
  assert.equal(receipt.approved_commit, f.base);
  assert.equal(receipt.baseline_commit, f.context.base_sha);
  assert.equal(receipt.integration.task_id, "PRIOR");
  assert.equal(progress.dependencies.tickets[0].acceptance, "accepted");
  assert.equal(progress.criteria[0].verification, "unverified");
  assert.equal(JSON.stringify(f.ref), frozen);
  assert.equal(await preflightBlockerContract(f.request, f.options), false);
  const resolved = await validateBlockerDisposition({ action: "resolved", summary: "Continue on inherited Sprint source",
    authority_quote: f.quote, guidance: "Implement the remaining selector criteria using completed dependencies.",
    evidence: [{ path: f.path, sha256: receipt.current_sha256 }] }, { job: { ...f.job, stage: "sprint_leader", reason_code: "CONTRACT_DECISION_REQUIRED" },
    plan: f.plan, fileService: f.files, projectRoot: f.root, verifyContractSource: f.verify });
  assert.equal(resolved.action, "resolved");
  await f.git.run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "later shared baseline"]);
  f.context.base_sha = (await f.git.run(["rev-parse", "HEAD"])).trim();
  f.workspace.base_commit = f.context.base_sha;
  assert.equal((await f.verify(f.ref)).provenance, "integrated_project_changes");
  await assert.rejects(f.verify({ ...f.ref, sha256: "0".repeat(64) }), { code: "BLOCKER_DISPOSITION_INVALID" });
  await f.files.atomicWrite({ path: f.path, content: "unreviewed external bytes", replace: true });
  await assert.rejects(f.verify(f.ref), { code: "TICKET_CONTRACT_SOURCE_CONFLICT" });
});

test("Coder continues journaled writes from the inherited baseline without reapproving its old checksum", async (t) => {
  const f = await inheritedFixture(t);
  const after = "export const route = 'selector implementation';\n";
  await f.ledger.write({ taskId: "T", path: f.path, before: f.updated, after });
  const receipt = await f.verify(f.ref);
  assert.equal(receipt.provenance, "ticket_owned_changes");
  assert.equal(receipt.integration.task_id, "PRIOR");
  assert.equal(receipt.approved_commit, f.base);
  assert.equal(receipt.baseline_sha256, f.ref.sha256);
});

test("waiting source recovery wakes SL once with validated dependencies and preserves the execution", async (t) => {
  const f = await inheritedFixture(t);
  const before = JSON.stringify(f.request);
  let now = 1;
  const refresh = createBlockerSourceResume({ inspect: async () => f.authority, ...f.services, clock: () => now });
  assert.equal(await refresh(f.job), true);
  assert.equal(f.job.ticket_progress.contract_source[0].status, "validated");
  assert.equal(f.job.ticket_progress.dependencies.tickets[0].status, "done");
  assert.equal(JSON.stringify(f.request), before);
  f.job.resolution = { reconciliation: { kind: "source_revision" } };
  now += 30_000;
  assert.equal(await refresh(f.job), false);
  f.status.status = "reviewing";
  now += 30_000;
  await assert.rejects(refresh(f.job), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
});

test("an incomplete predecessor or foreign project never supplies inherited acceptance", async (t) => {
  const f = await inheritedFixture(t);
  f.prior.state = "coding";
  await assert.rejects(f.verify(f.ref), { code: "BLOCKER_DISPOSITION_INVALID" });
  f.prior.state = "terminal";
  f.prior.project_id = "FOREIGN";
  await assert.rejects(f.verify(f.ref), { code: "BLOCKER_DISPOSITION_INVALID" });
  f.status.details.execution_id = "NEW-ATTEMPT";
  await assert.rejects(buildBlockerTicketProgress({ job: f.job, ...f.authority, ...f.services }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
});

test("a new reconciliation receipt wakes retained SL even when contract and dependency evidence are unchanged", async (t) => {
  const f = await inheritedFixture(t);
  let source = { status: "observed", sha256: "before", files: [] };
  f.workspace.gitService = { inspectSource: async () => source };
  f.job.ticket_progress = await buildBlockerTicketProgress({ job: f.job, ...f.authority, ...f.services });
  source = { status: "observed", sha256: "after", files: [{ path: "source.js", source_reconciliation: { status: "merged" } }] };
  let now = 1;
  const refresh = createBlockerSourceResume({ inspect: async () => f.authority, ...f.services, clock: () => now });
  assert.equal(await refresh(f.job), true);
  assert.equal(f.job.ticket_progress.source_reconciliation.sha256, "after");
  f.job.resolution = { reconciliation: { kind: "source_revision" } };
  now += 30_000;
  assert.equal(await refresh(f.job), false);
});
