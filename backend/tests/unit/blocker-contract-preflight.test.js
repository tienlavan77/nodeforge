// Verifies that dispatch inherits authenticated AM decisions without reopening resolved consultations or changing immutable ticket policy.
import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../fixtures/ticket-contract-source-fixture.js";
import { retainBlockerContract } from "../../src/modules/supervisor/blocker-contract-evidence.js";
import { preflightBlockerContract } from "../../src/modules/supervisor/blocker-contract-preflight.js";
import { coderProductionRecoveryFixture, TICKET } from "../fixtures/coder-production-recovery-fixture.js";
import { createProductionBlockerRecovery } from "../../src/modules/supervisor/blocker-recovery-runtime.js";
import { createHash } from "node:crypto";

const basis = { plan_id: "ARCH", revision: 1, sha256: "a".repeat(64) };
const quote = "Implement the approved feature within existing project and security boundaries.";

// Creates a real immutable AM receipt and persisted checkpoint while leaving the original ticket evidence empty.
async function retainedFixture(t) {
  const f = await fixture(t);
  f.ticket.execution_policy.contract_evidence = [];
  Object.assign(f.plan, { proposal_id: `ARCH-R1-${basis.sha256}`, source_path: "approved.md", source_sha256: basis.sha256 });
  f.options.fileService = f.files;
  f.options.architecturePlans = { assertApproved: async () => ({ ...basis, project_id: "P", file_path: "approved.md", markdown: quote }) };
  const decision = { action: "resolved", authority_scope: "architecture", architecture_basis: basis, authority_quote: quote,
    summary: "Implement the fail-closed adapter within the approved scope.", guidance: "Use explicit injected permission ports; do not introduce an account policy.",
    evidence: [], boundary_assessment: { rationale: "The approved scope remains unchanged.", changes_structure: false,
      changes_owner_scope: false, changes_security_policy: false, changes_data_semantics: false, overrides_guardrails: false, changes_ticket_contract: false } };
  const job = { id: "RESOLVED", request: f.request, history: [{ stage: "architecture_manager", completed_at: 1000,
    actor: { agent_id: "AM", role: "architecture_manager" }, disposition: decision }] };
  const receipts = await retainBlockerContract({ job, checkpoint: f.checkpoint(), fileService: f.files });
  await f.options.checkpoints.save({ ...f.checkpoint(), contract_decisions: receipts, phase: "blocker_resolved" });
  return { ...f, job, receipts };
}

test("empty static evidence inherits the retained AM decision on repeated resume without another blocker", async (t) => {
  const f = await retainedFixture(t);
  const before = structuredClone(f.checkpoint());
  const policy = structuredClone(f.ticket.execution_policy);
  for (let attempt = 0; attempt < 2; attempt += 1) assert.equal(await preflightBlockerContract(f.request, f.options), false);
  assert.deepEqual(f.checkpoint(), before);
  assert.deepEqual(f.ticket.execution_policy, policy);
  assert.deepEqual(f.events, []);
  assert.equal(f.logs.at(-1).payload.authority, "retained_architecture_decision");
  assert.deepEqual(f.logs.at(-1).payload.receipts, f.receipts.map(({ path, sha256 }) => ({ path, sha256 })));
});

test("request-supplied receipt objects cannot replace the stored checkpoint authority", async (t) => {
  const f = await retainedFixture(t);
  f.request.payload.resume_from = structuredClone(f.checkpoint());
  await f.options.checkpoints.save({ ...f.checkpoint(), contract_decisions: [] });
  assert.equal(await preflightBlockerContract(f.request, f.options), true);
  assert.equal(f.checkpoint().triage.reason_code, "CONTRACT_DECISION_REQUIRED");
});

test("tampered, missing and foreign authority cannot bypass contract preflight", async (t) => {
  for (const mutation of ["checksum", "path", "missing", "project", "ticket", "execution", "sprint", "architecture", "boundary"]) {
    await t.test(mutation, async (t) => {
      const f = await retainedFixture(t);
      if (mutation === "checksum") await f.files.atomicWrite({ path: f.receipts[0].path, content: "changed", replace: true });
      if (mutation === "path") f.receipts[0].path = ".forge/runtime/other.json";
      if (mutation === "missing") {
        f.receipts[0].path = `.forge/runtime/blocker-contract-decisions/${"b".repeat(64)}.json`;
        f.receipts[0].sha256 = "b".repeat(64);
      }
      if (mutation === "project") f.request.project_id = "FOREIGN";
      if (mutation === "ticket") f.request.task_id = "OTHER";
      if (mutation === "execution") f.request.payload.execution_id = "NEW";
      if (mutation === "sprint") f.request.payload.sprint_basis = { version: 2 };
      if (mutation === "architecture") f.options.architecturePlans.assertApproved = async () => ({ ...basis, project_id: "FOREIGN" });
      if (mutation === "boundary") {
        const history = structuredClone(f.job.history);
        history[0].disposition.boundary_assessment.changes_security_policy = true;
        const receipts = await retainBlockerContract({ job: { ...f.job, history }, fileService: f.files });
        await f.options.checkpoints.save({ ...f.checkpoint(), contract_decisions: receipts });
      }
      assert.equal(await preflightBlockerContract(f.request, f.options), true);
      assert.equal(f.checkpoint().last_completed_turn, 33);
      assert.equal(f.events.at(-1).type, "task.needs_human_review");
    });
  }
});

test("an obsolete approved Architecture receipt requires a new matching decision", async (t) => {
  const f = await retainedFixture(t);
  const next = { ...basis, revision: 2, sha256: "b".repeat(64) };
  Object.assign(f.plan, { proposal_id: `ARCH-R2-${next.sha256}`, source_sha256: next.sha256 });
  f.options.architecturePlans.assertApproved = async () => ({ ...next, project_id: "P", file_path: "approved.md", markdown: quote });
  assert.equal(await preflightBlockerContract(f.request, f.options), true);
});

test("retained AM authority does not skip validation of declared source evidence", async (t) => {
  const f = await retainedFixture(t);
  f.ticket.execution_policy.contract_evidence = [f.ref];
  assert.equal(await preflightBlockerContract(f.request, f.options), false);
  f.ref.sha256 = "0".repeat(64);
  assert.equal(await preflightBlockerContract(f.request, f.options), true);
});

test("storage failures propagate rather than being described as a missing contract", async (t) => {
  const f = await retainedFixture(t);
  f.options.fileService = { readFile: async () => { throw Object.assign(new Error("Storage unavailable"), { code: "EIO" }); } };
  await assert.rejects(preflightBlockerContract(f.request, f.options), { code: "EIO" });
  assert.deepEqual(f.events, []);
});

test("preflight inspection leaves a stopped recovery checkpoint paused", async (t) => {
  const f = await retainedFixture(t);
  await f.options.checkpoints.save({ ...f.checkpoint(), phase: "blocker_triage_cancelled", blocker_recovery: { status: "cancelled" } });
  const before = structuredClone(f.checkpoint());
  assert.equal(await preflightBlockerContract(f.request, f.options), false);
  assert.deepEqual(f.checkpoint(), before);
  assert.deepEqual(f.events, []);
});

test("production dispatch resumes after AM and SL resolve an empty-evidence contract without creating another recovery job", async (t) => {
  const ticket = { ...TICKET, objective: quote, execution_policy: { ...TICKET.execution_policy, requires_existing_contract: true, contract_evidence: [] } };
  const f = await coderProductionRecoveryFixture({ ticket, behavior: async ({ onEvent }) => {
    for (const tool of ["write_diff", "commit_changes", "report_done"]) await onEvent({ type: "item.completed",
      item: { id: tool, type: "mcp_tool_call", server: "forge", tool, status: "completed" } });
    return { text: "Reported" };
  } });
  t.after(() => f.close());
  const source = "export const permission = false;\n";
  const evidence = { path: "backend/src/permission.js", sha256: createHash("sha256").update(source).digest("hex") };
  await f.fileService.atomicWrite({ path: evidence.path, content: source, replace: false });
  const assertReady = f.registry.assertReady;
  f.registry.assertReady = async (...args) => {
    const ready = await assertReady(...args);
    return { ...ready, plan: { ...ready.plan, proposal_id: `ARCH-R1-${basis.sha256}`, source_path: "approved.md", source_sha256: basis.sha256 } };
  };
  const calls = [];
  const recovery = createProductionBlockerRecovery({ store: f.store, fileService: f.fileService, ticketStatusStore: f.statusStore,
    sprintRegistry: f.registry, resolveTicketWorkspace: async () => f.workspace, checkpoints: f.checkpoints, eventBus: f.eventBus,
    agentOccupancy: f.occupancy, submitTicket: (request) => f.service.runTicket(request), clock: () => 1000,
    disposition: { get: async () => null }, logger: { error: console.error, warn: console.warn },
    architecturePlans: { assertApproved: async () => ({ ...basis, project_id: "P", file_path: "approved.md", markdown: quote }) },
    investigate: async (job) => {
      calls.push(job.stage);
      if (job.stage === "sprint_leader" && !job.architecture_response) return { action: "architecture_required", summary: "The missing contract requires an Architecture answer." };
      const resolution = { action: "resolved", summary: "The approved contract is settled.", guidance: "Implement the approved adapter and submit the report.",
        authority_scope: "sprint", authority_quote: quote, evidence: [evidence] };
      return job.stage === "architecture_manager" ? { ...resolution, authority_scope: "architecture", architecture_basis: basis,
        boundary_assessment: { rationale: "The existing scope is preserved.", changes_structure: false, changes_owner_scope: false,
          changes_security_policy: false, changes_data_semantics: false, overrides_guardrails: false, changes_ticket_contract: false } } : resolution;
    } });
  t.after(() => recovery.stop());
  f.restart({ blockerRecovery: recovery });
  assert.equal((await f.run()).status, "needs_human_review");
  assert.equal(f.invocations, 0);
  for (let step = 0; step < 8 && f.statusStore.get().status !== "done"; step += 1) await recovery.tick();
  assert.equal(f.statusStore.get().status, "done");
  assert.deepEqual(calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
  assert.equal(f.invocations, 1);
  assert.equal(f.integrations, 1);
  const ledger = (await f.store.list("blocker.recovery"))[0];
  assert.equal(ledger.jobs.length, 1);
  assert.equal(ledger.jobs[0].status, "resumed");
  assert.equal((await f.checkpoints.load("TASK")).contract_decisions.length, 1);
});
