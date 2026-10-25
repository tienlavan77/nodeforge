// Tests scoped inheritance of AM contracts across Resume and review-policy-only plan revisions.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { readBlockerContracts, retainBlockerContract } from "../../src/modules/supervisor/blocker-contract-evidence.js";
import { createReviewWorker } from "../../src/modules/supervisor/review-worker.js";

// Stores two exact plan revisions and an original AM receipt to exercise real checksum-bound inheritance.
async function fixture(t, alter = () => {}) {
  const fixture = await blockerRecoveryFixture();
  t.after(() => fixture.close());
  const fileService = fixture.base.fileService;
  const content = { objective: "Deliver conventions", approach: "Review with at most two revision/re-review cycles after initial review",
    tickets: ["TASK"], ticket_specs: [{ id: "TASK", objective: "Repair with at most two revision/re-review cycles after initial review; exhausted revisions remain blocked or failed, never implicitly accepted",
      acceptance_criteria: ["Count all code lines"], verification_plan: [{ kind: "test", test_path: "budget.test.js" }], execution_policy: { requires_existing_contract: true } }] };
  const basis = { project_id: "P", sprint_id: "SPRINT", plan_id: "PLAN", version: 1, plan_revision: 1, plan_path: "plans/PLAN/1.json" };
  const artifact = { project_id: "P", sprint_id: "SPRINT", plan_id: "PLAN", revision: 1, source_path: "approved.md", source_sha256: "a".repeat(64), proposal_id: "PARENT", content };
  const next = structuredClone(artifact);
  next.revision = 2;
  next.content.approach = "Review with no fixed limit on revision/re-review cycles";
  next.content.ticket_specs[0].objective = "Repair with no fixed limit on revision/re-review cycles";
  alter(next);
  const after = { ...basis, version: 2, plan_revision: 2, plan_path: "plans/PLAN/2.json" };
  for (const [plan, bound] of [[artifact, basis], [next, after]]) {
    const bytes = `${JSON.stringify(plan)}\n`;
    bound.plan_sha256 = createHash("sha256").update(bytes).digest("hex");
    await fileService.atomicWrite({ path: bound.plan_path, content: bytes, replace: false });
  }
  const original = { project_id: "P", task_id: "TASK", execution_id: "EXEC-1", sprint_basis: basis };
  const receipts = await retainBlockerContract({ fileService, job: { id: "JOB", request: { ...original, payload: original },
    history: [{ stage: "architecture_manager", completed_at: 1000, actor: { agent_id: "AM", role: "architecture_manager" },
      disposition: { action: "resolved", authority_scope: "architecture", guidance: "Preserve the Markdown read contract." } }] } });
  const binding = { ...original, execution_id: "EXEC-2", sprint_basis: after };
  return { fileService, receipts, original, binding, projectRoot: fixture.base.workspace.projectRoot };
}

test("review-policy amendment inherits the original AM answer without rewriting its authority or execution", async (t) => {
  const f = await fixture(t);
  const bytes = await f.fileService.readFile({ path: f.receipts[0].path });
  const [result] = await readBlockerContracts({ ...f, allowContinuation: true });
  assert.equal(result.continuation.reason, "review_policy_only_amendment");
  assert.equal(result.continuation.execution_id, "EXEC-2");
  assert.equal(result.record.execution_id, "EXEC-1");
  assert.equal(result.record.validated_at, "1970-01-01T00:00:01.000Z");
  assert.equal(result.record.actor.agent_id, "AM");
  assert.equal(await f.fileService.readFile({ path: f.receipts[0].path }), bytes);
  await assert.rejects(readBlockerContracts(f), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" });
});

test("a new RUN may inherit unchanged scope only when Node enables continuation", async (t) => {
  const f = await fixture(t);
  const binding = { ...f.binding, sprint_basis: f.original.sprint_basis };
  const [result] = await readBlockerContracts({ ...f, binding, allowContinuation: true });
  assert.equal(result.continuation.reason, "same_approved_plan");
  for (const key of ["task_id", "project_id"]) await assert.rejects(readBlockerContracts({ ...f, allowContinuation: true, binding: { ...binding, [key]: "FOREIGN" } }), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" });
});

for (const kind of ["criteria", "permission", "verification", "parent", "scope"]) {
  test(`continuation rejects ${kind} changes alongside a review-policy amendment`, async (t) => {
    const f = await fixture(t, (plan) => {
      if (kind === "criteria") plan.content.ticket_specs[0].acceptance_criteria = ["Weakened"];
      if (kind === "permission") plan.content.ticket_specs[0].execution_policy = {};
      if (kind === "verification") plan.content.ticket_specs[0].verification_plan = [];
      if (kind === "parent") plan.source_sha256 = "b".repeat(64);
      if (kind === "scope") plan.content.ticket_specs[0].objective += " and redesign security";
    });
    await assert.rejects(readBlockerContracts({ ...f, allowContinuation: true }), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" });
  });
}

test("a changed plan file cannot establish continuation even with an unchanged approval reference", async (t) => {
  const f = await fixture(t);
  await f.fileService.atomicWrite({ path: f.binding.sprint_basis.plan_path, content: "{}", replace: true });
  await assert.rejects(readBlockerContracts({ ...f, allowContinuation: true }), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" });
});

test("the Reviewer receives inherited AM terms with the original receipt and explicit continuation provenance", async (t) => {
  const f = await fixture(t);
  let prompt;
  const worker = createReviewWorker({ projectRoot: f.projectRoot, contractFileService: f.fileService,
    agentResolver: { resolveAvailable: () => ({ agent_id: "REVIEWER", provider: "openai", role: "reviewer" }) },
    fileService: { readForIndex: async ({ path }) => ({ path, sha256: "source", size_bytes: 12, content: "const ok = true;" }) },
    openaiSdkGateway: { execute: async (input) => { prompt = input.prompt; return { text: '{"verdict":"approved","findings":[]}' }; } } });
  await worker.review({ request_id: "REVIEW-TASK", task_id: "TASK", project_id: "P", agent_id: "CODER", payload: {
    ...f.binding, commit: "a".repeat(40), ticket: { id: "TASK" }, changed_paths: ["src/file.js"], contract_decisions: f.receipts } });
  assert.match(prompt, /Preserve the Markdown read contract/);
  assert.match(prompt, /review_policy_only_amendment/);
  assert.match(prompt, /EXEC-1/);
  assert.match(prompt, /EXEC-2/);
});
