// Exercises historical contract approval and ticket-owned source changes without waiving acceptance or mutation gates.
import { fixture } from "../fixtures/ticket-contract-source-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createTicketContractSource } from "../../src/modules/supervisor/ticket/ticket-contract-source.js";
import { findIntegratedTicketSource } from "../../src/modules/supervisor/ticket/ticket-integrated-source.js";
import { preflightBlockerContract } from "../../src/modules/supervisor/blocker/blocker-contract-preflight.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker/blocker-recovery-contract.js";
import { buildBlockerTicketProgress, ticketProgressPrompt } from "../../src/modules/supervisor/blocker/blocker-ticket-progress.js";

// Hashes exact source bytes for approval and ledger comparisons.
const hash = (content) => createHash("sha256").update(content).digest("hex");


test("preflight validates historical baseline and permits journaled ticket edits without resetting checkpoint", async (t) => {
  const f = await fixture(t);
  await f.write();
  const frozen = JSON.stringify(f.ticket.execution_policy);
  assert.equal(await preflightBlockerContract(f.request, f.options), false);
  const receipt = f.logs.find((event) => event.event_name === "ticket.contract_preflight_passed").payload.receipts[0];
  assert.equal(receipt.baseline_commit, f.base);
  assert.equal(receipt.baseline_sha256, f.ref.sha256);
  assert.equal(receipt.current_sha256, hash(f.updated));
  assert.equal(receipt.provenance, "ticket_owned_changes");
  assert.equal(f.checkpoint().last_completed_turn, 33);
  assert.equal(f.events.length, 0);
  assert.equal(JSON.stringify(f.ticket.execution_policy), frozen);
  assert.deepEqual(await createTicketContractSource({ request: f.request, workspace: f.workspace })(f.ref), receipt);
});

test("unchanged source still validates the exact historical contract", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.verify(f.ref)).provenance, "unchanged");
  await assert.rejects(f.verify({ ...f.ref, sha256: "0".repeat(64) }), (error) => error.validation_errors[0].reason === "contract_baseline_mismatch");
});

test("SL receives Node historical validation instead of waiting for an unavailable admission receipt", async (t) => {
  const f = await fixture(t);
  await f.write();
  const job = { request: f.request, history: [] };
  const progress = await buildBlockerTicketProgress({ job, checkpoint: f.checkpoint(), workspace: f.workspace });
  assert.equal(progress.contract_source[0].status, "validated");
  assert.equal(progress.contract_source[0].provenance, "ticket_owned_changes");
  assert.match(ticketProgressPrompt({ ...job, ticket_progress: progress }), /do not wait for Node to supply that same result again/);
  await f.files.atomicWrite({ path: f.path, content: "external edit", replace: true });
  const stale = await buildBlockerTicketProgress({ job, checkpoint: f.checkpoint(), workspace: f.workspace });
  assert.equal(stale.contract_source[0].status, "blocked");
  assert.equal(stale.contract_source[0].code, "TICKET_CONTRACT_SOURCE_CONFLICT");
});

test("replacing the approved checksum with current source never approves a new contract", async (t) => {
  const f = await fixture(t);
  await f.write();
  f.ref.sha256 = hash(f.updated);
  assert.equal(await preflightBlockerContract(f.request, f.options), true);
  assert.equal(f.checkpoint().triage.reason_code, "CONTRACT_DECISION_REQUIRED");
  assert.equal(f.checkpoint().last_completed_turn, 33);
});

test("external source drift is a source conflict rather than another contract design request", async (t) => {
  const f = await fixture(t);
  await f.write();
  await f.files.atomicWrite({ path: f.path, content: "unowned edit", replace: true });
  assert.equal(await preflightBlockerContract(f.request, f.options), true);
  assert.equal(f.checkpoint().triage.reason_code, "SCOPE_CONFLICT");
  assert.match(f.checkpoint().failure.message, /source requires reconciliation/);
  await f.files.atomicWrite({ path: f.path, content: f.original, replace: true });
  await assert.rejects(f.verify(f.ref), { code: "TICKET_CONTRACT_SOURCE_CONFLICT" });
});

test("an unjournaled or other-ticket change cannot use the approved baseline as a bypass", async (t) => {
  const f = await fixture(t);
  await f.files.atomicWrite({ path: f.path, content: f.updated, replace: true });
  await assert.rejects(f.verify(f.ref), { code: "TICKET_CONTRACT_SOURCE_CONFLICT" });
  await f.files.atomicWrite({ path: f.path, content: f.original, replace: true });
  await f.ledger.write({ taskId: "OTHER", path: f.path, before: f.original, after: f.updated });
  await assert.rejects(f.verify(f.ref), { code: "TICKET_CONTRACT_SOURCE_CONFLICT" });
});

test("wrong project, baseline identity and broken journal chains never admit Coder", async (t) => {
  const f = await fixture(t);
  await f.write();
  f.context.project_id = "OTHER";
  await assert.rejects(f.verify(f.ref), { code: "TICKET_CONTRACT_SOURCE_CONFLICT" });
  f.context.project_id = "P";
  f.workspace.base_commit = "b".repeat(40);
  await assert.rejects(f.verify(f.ref), { code: "TICKET_CONTRACT_SOURCE_CONFLICT" });
  f.workspace.base_commit = f.base;
  const manifest = await f.ledger.snapshot("T");
  manifest.entries[f.path].operations[0].after = "unrecorded content";
  f.workspace.changeLedger.snapshot = async () => manifest;
  await assert.rejects(f.verify(f.ref), { code: "TICKET_CONTRACT_SOURCE_CONFLICT" });
});

test("journaled deletion is attributable but still requires all normal contract acceptance checks", async (t) => {
  const f = await fixture(t);
  await f.ledger.write({ taskId: "T", path: f.path, before: f.original, after: null });
  const receipt = await f.verify(f.ref);
  assert.equal(receipt.provenance, "ticket_owned_changes");
  assert.equal(receipt.current_sha256, null);
  assert.equal(receipt.baseline_sha256, hash(f.original));
});

test("unexpected storage faults propagate and path traversal cannot read historical Git objects", async (t) => {
  const f = await fixture(t);
  await f.write();
  f.workspace.changeLedger.snapshot = async () => { throw Object.assign(new Error("Storage unavailable"), { code: "EIO" }); };
  await assert.rejects(f.verify(f.ref), { code: "EIO" });
  await assert.rejects(f.verify({ ...f.ref, path: "../outside.js" }));
});

test("SL can resolve an unchanged contract against baseline or current ticket source, but not invented evidence", async (t) => {
  const f = await fixture(t);
  await f.write();
  const job = { stage: "sprint_leader", reason_code: "CONTRACT_DECISION_REQUIRED", request: f.request };
  const options = { job, plan: f.plan, fileService: f.files, projectRoot: f.root, verifyContractSource: f.verify };
  const value = { action: "resolved", summary: "Continue the original approved contract", guidance: "Finish the selected handler; run every mapped acceptance check.", authority_quote: f.quote };
  for (const sha256 of [f.ref.sha256, hash(f.updated)]) {
    assert.equal((await validateBlockerDisposition({ ...value, evidence: [{ path: f.path, sha256 }] }, options)).action, "resolved");
  }
  await assert.rejects(validateBlockerDisposition({ ...value, evidence: [{ path: f.path, sha256: "0".repeat(64) }] }, options), { code: "BLOCKER_DISPOSITION_INVALID" });
  await assert.rejects(validateBlockerDisposition({ ...value, authority_quote: "An invented contract does not grant execution authority", evidence: [f.ref] }, options), { code: "BLOCKER_DISPOSITION_INVALID" });
  await f.files.atomicWrite({ path: f.path, content: "external drift after SL review", replace: true });
  await assert.rejects(validateBlockerDisposition({ ...value, evidence: [f.ref] }, options), { code: "TICKET_CONTRACT_SOURCE_CONFLICT" });
});

test("legacy unchanged evidence remains readable but cannot admit drift without a historical identity", async (t) => {
  const f = await fixture(t);
  delete f.context.base_sha;
  delete f.workspace.base_commit;
  assert.equal((await f.verify(f.ref)).provenance, "unchanged_live");
  await f.write();
  await assert.rejects(f.verify(f.ref), (error) => error.validation_errors[0].reason === "contract_baseline_missing");
});

test("SL Sprint authority and supporting source evidence need not duplicate the contract approval quotation", async (t) => {
  const f = await fixture(t);
  await f.write();
  const supporting = "export const service = true;\n";
  await f.files.atomicWrite({ path: "backend/service.js", content: supporting, replace: false });
  const sprintQuote = "Compose complete project-bound application services without changing existing public routes.";
  f.plan.content.approach = sprintQuote;
  const job = { stage: "sprint_leader", reason_code: "CONTRACT_DECISION_REQUIRED", request: f.request };
  const options = { job, plan: f.plan, fileService: f.files, projectRoot: f.root, verifyContractSource: f.verify };
  const value = { action: "resolved", summary: "Continue approved service composition", authority_quote: sprintQuote,
    guidance: "Finish missing composition and verify compatibility for every criterion.",
    evidence: [{ path: f.path, sha256: hash(f.updated) }, { path: "backend/service.js", sha256: hash(supporting) }] };
  assert.equal((await validateBlockerDisposition(value, options)).action, "resolved");
  value.evidence[1].sha256 = "0".repeat(64);
  await assert.rejects(validateBlockerDisposition(value, options), (error) => error.validation_errors[0].reason === "evidence_stale");
  value.evidence.pop();
  f.ref.authority_quote = "An invented approval cannot be accepted as an existing contract.";
  await assert.rejects(validateBlockerDisposition(value, options), (error) => error.validation_errors[0].reason === "authority_not_grounded");
});

// Proves repair provenance without reclaiming historical files or accepting unrelated live drift.
test("completed review repair chains archived writes with only current-cycle changes", async (t) => {
  const f = await fixture(t);
  await f.write();
  const archived = await f.ledger.snapshot("T");
  f.context.review_repair_cycle_id = "owner-cycle";
  f.workspace.loadReviewRepairSource = async () => [archived];
  const current = { task_id: "T", project_id: "P", revision: archived.revision + 1, entries: {} };
  f.workspace.changeLedger.snapshot = async () => current;
  assert.equal((await f.verify(f.ref)).provenance, "ticket_owned_changes");
  const next = "export const route = 'review fix';\n";
  const entry = structuredClone(archived.entries[f.path]);
  entry.initial_content = f.updated; entry.initial_sha = `sha256:${hash(f.updated)}`;
  entry.latest_sha = `sha256:${hash(next)}`;
  entry.operations = [{ status: "completed", before: f.updated, after: next, before_sha: entry.initial_sha, after_sha: entry.latest_sha }];
  current.entries[f.path] = entry;
  await f.files.atomicWrite({ path: f.path, content: next, replace: true });
  assert.equal((await f.verify(f.ref)).current_sha256, hash(next));
  await f.files.atomicWrite({ path: f.path, content: "foreign drift", replace: true });
  await assert.rejects(f.verify(f.ref), { code: "TICKET_CONTRACT_SOURCE_CONFLICT" });
  f.workspace.loadReviewRepairSource = undefined;
  await assert.rejects(f.verify(f.ref), { code: "TICKET_CONTRACT_SOURCE_CONFLICT" });
});

// Treats committed dependency evidence separately from ownership of the repair's new files.
test("review repair accepts an integrated dependency but never unproved live bytes", async (t) => {
  const f = await fixture(t);
  f.context.review_repair_cycle_id = "owner-cycle";
  f.workspace.loadReviewRepairSource = async () => [];
  f.workspace.findIntegratedSource = async (path, sha256, targetSha256) => path === f.path && sha256 === f.ref.sha256 && targetSha256 === hash(f.updated) ? { task_id: "OTHER", commit: "c" } : null;
  await f.files.atomicWrite({ path: f.path, content: f.updated, replace: true });
  assert.equal((await f.verify(f.ref)).provenance, "integrated_project_changes");
  await f.files.atomicWrite({ path: f.path, content: "unproved edit", replace: true });
  await assert.rejects(f.verify(f.ref), { code: "TICKET_CONTRACT_SOURCE_CONFLICT" });
  delete f.context.review_repair_cycle_id;
  await f.files.atomicWrite({ path: f.path, content: f.updated, replace: true });
  assert.equal((await f.verify(f.ref)).provenance, "integrated_project_changes");
});

test("pipeline contract validation accepts a completed prior ticket integration on the same project", async (t) => {
  const f = await fixture(t);
  const priorTask = "TICKET-PRIOR-CONTRACT";
  await f.files.atomicWrite({ path: f.path, content: f.updated, replace: true });
  await f.git.run(["add", "--", f.path]);
  await f.git.run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "prior contract integration"]);
  const integratedCommit = (await f.git.run(["rev-parse", "HEAD"])).trim();
  const priorContext = { task_id: priorTask, project_id: "P", state: "terminal", review_commit_sha: integratedCommit,
    verification_artifact_id: "ARTIFACT-PRIOR", manifest_sha: "manifest-prior", source_revision: "revision-prior", manifest_paths: [f.path] };
  const originalLoad = f.workspace.executionContexts.load;
  f.workspace.executionContexts.load = async (taskId) => taskId === priorTask ? priorContext : originalLoad(taskId);
  f.workspace.findIntegratedSource = (path, sha256, targetSha256, baselineCommit) => findIntegratedTicketSource({ path, sha256, targetSha256, baselineCommit, taskId: "T", projectId: "P", fileService: f.files, executionContexts: f.workspace.executionContexts, rootGit: f.git });
  await f.files.atomicWrite({ path: `.forge/runtime/ticket-integrations/${priorTask}.json`, content: JSON.stringify({
    task_id: priorTask, status: "completed", workspace_mode: "worktree", reviewed_commit: integratedCommit, commit: integratedCommit
  }), replace: false });
  assert.equal((await f.verify(f.ref)).provenance, "integrated_project_changes");
});
