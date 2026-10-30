// Verifies immutable AM decision receipts remain readable across recovery, repair and independent review.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { retainBlockerContract, readBlockerContracts, blockerContractPrompt } from "../../src/modules/supervisor/blocker/blocker-contract-evidence.js";
import { buildResumePrompt, createResumeState } from "../../src/modules/supervisor/ticket/ticket-resume.js";
import { createReviewWorker } from "../../src/modules/supervisor/review/review-worker.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

test("concurrent and repeated AM receipt retention reuses identical bytes without cleanup error logs", async (t) => {
  const f = await blockerRecoveryFixture(); t.after(f.close);
  const logs = [];
  // Uses independent write queues to reproduce two recovery workers retaining the same immutable decision.
  const open = () => createFileService({ projectRoot: f.base.workspace.projectRoot, logger: { error: (...args) => logs.push(args) } });
  const first = open(), second = open();
  const job = { id: "REPEATED", request: { project_id: "P", task_id: "TASK", payload: { execution_id: "EXEC" } },
    history: [{ stage: "architecture_manager", completed_at: 1000,
      disposition: { action: "resolved", authority_scope: "architecture", guidance: "Continue the retained checkpoint." } }] };
  const [left, right] = await Promise.all([first, second].map((fileService) => retainBlockerContract({ job, fileService })));
  assert.deepEqual(left, right);
  const original = await first.readFile({ path: left[0].path });
  const checkpoint = { contract_decisions: left };
  assert.deepEqual(await retainBlockerContract({ job, checkpoint, fileService: second }), left);
  assert.equal(await first.readFile({ path: left[0].path }), original);
  assert.deepEqual(logs, []);
  await first.atomicWrite({ path: left[0].path, content: "conflicting stored receipt", replace: true });
  await assert.rejects(retainBlockerContract({ job, checkpoint, fileService: second }), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" });
  assert.equal(await first.readFile({ path: left[0].path }), "conflicting stored receipt");
  assert.deepEqual(logs, []);
});

test("AM receipt retention propagates real storage failures instead of treating them as existing evidence", async () => {
  const error = Object.assign(new Error("Storage unavailable"), { code: "EIO" });
  const fileService = { atomicCreate: async () => { throw error; }, readFile: async () => assert.fail("Storage failure is not an existing receipt") };
  const job = { id: "IO", request: { project_id: "P", task_id: "TASK", payload: { execution_id: "EXEC" } },
    history: [{ stage: "architecture_manager", completed_at: 1000, disposition: { action: "resolved", authority_scope: "architecture" } }] };
  await assert.rejects(retainBlockerContract({ job, fileService }), (failure) => failure === error);
});

test("AM receipts retain full terms, actor and chronology without granting Owner approval", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const binding = { project_id: "P", task_id: "TASK", execution_id: "EXEC", sprint_basis: { project_id: "P", version: 1 } };
    const job = { id: "JOB", request: { ...binding, payload: binding }, history: [{ stage: "architecture_manager", completed_at: 1000,
      actor: { agent_id: "AM", role: "architecture_manager", provider: "openai" }, disposition: {
        action: "resolved", authority_scope: "architecture", architecture_basis: { plan_id: "PLAN", revision: 1, sha256: "b".repeat(64) },
        guidance: "Keep unattributed legacy rows NULL; do not guess their project.", evidence: [fixture.evidence] } }] };
    const receipts = await retainBlockerContract({ job, fileService: fixture.base.fileService });
    const checkpoint = { task_id: "TASK", status: "in_progress", contract_decisions: receipts };
    assert.deepEqual(await retainBlockerContract({ job, checkpoint, fileService: fixture.base.fileService }), receipts);
    const read = await readBlockerContracts({ receipts, fileService: fixture.base.fileService, binding });
    assert.equal(read[0].record.actor.agent_id, "AM");
    assert.equal(read[0].record.validated_at, "1970-01-01T00:00:01.000Z");
    assert.match(blockerContractPrompt(read), /not new Owner approval/);
    assert.match(buildResumePrompt("Ticket", createResumeState(checkpoint)), /Keep unattributed legacy rows NULL/);
    let prompt;
    const worker = createReviewWorker({ projectRoot: fixture.base.workspace.projectRoot, contractFileService: fixture.base.fileService,
      agentResolver: { resolveAvailable: () => ({ agent_id: "REVIEWER", provider: "openai", role: "reviewer" }) },
      fileService: { readForIndex: async ({ path }) => ({ path, sha256: "source", size_bytes: 12, content: "const ok = true;" }) },
      openaiSdkGateway: { execute: async (input) => { prompt = input.prompt; return { text: '{"verdict":"approved","findings":[]}' }; } } });
    const review = { request_id: "REVIEW-TASK", task_id: "TASK", project_id: "P", agent_id: "CODER", payload: { ticket: { id: "TASK" }, commit: "a".repeat(40),
      execution_id: "EXEC", sprint_basis: binding.sprint_basis, changed_paths: ["src/file.js"], contract_decisions: receipts } };
    await worker.review(review);
    assert.match(prompt, /Keep unattributed legacy rows NULL/);
    assert.match(prompt, /recorded_provider_identity/);
    prompt = null;
    await assert.rejects(worker.review({ ...review, project_id: "FOREIGN" }), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" });
    assert.equal(prompt, null);
    for (const altered of [{ ...binding, project_id: "OTHER" }, { ...binding, task_id: "OTHER" },
      { ...binding, execution_id: "OTHER" }, { ...binding, sprint_basis: { version: 2 } }]) {
      await assert.rejects(readBlockerContracts({ receipts, fileService: fixture.base.fileService, binding: altered }), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" });
    }
    await fixture.base.fileService.atomicWrite({ path: receipts[0].path, content: "tampered", replace: true });
    await assert.rejects(readBlockerContracts({ receipts, fileService: fixture.base.fileService, binding }), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" });
  } finally { await fixture.close(); }
});

test("historical accepted AM decisions never fabricate an unavailable approver identity", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const job = { id: "OLD", request: { project_id: "P", task_id: "TASK", payload: { execution_id: "EXEC" } },
      history: [{ stage: "architecture_manager", completed_at: 1000, disposition: { action: "resolved", authority_scope: "architecture" } }] };
    const [receipt] = await retainBlockerContract({ job, fileService: fixture.base.fileService });
    assert.equal(receipt.record.actor, null);
    assert.equal(receipt.record.actor_status, "historical_identity_unavailable");
    assert.deepEqual(await retainBlockerContract({ job: { ...job, history: [] }, checkpoint: { contract_decisions: [receipt] }, fileService: fixture.base.fileService }), [receipt]);
  } finally { await fixture.close(); }
});

test("AM receipts survive Sprint projection without accepting a different plan, version, or execution", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    const basis = { project_id: "P", sprint_id: "SPRINT", plan_id: "PLAN", plan_revision: 1,
      plan_path: "plans/PLAN/1.json", plan_sha256: "a".repeat(64), version: 1 };
    const binding = { project_id: "P", task_id: "TASK", execution_id: "EXEC", sprint_basis: basis };
    const job = { id: "JOB", request: { ...binding, payload: { ...binding, sprint_basis: { ...basis, status: "ready", position: 7, dependencies: [], created_at: "before", updated_at: "before" } } },
      history: [{ stage: "architecture_manager", completed_at: 1000, actor: { agent_id: "AM", role: "architecture_manager" },
        disposition: { action: "resolved", authority_scope: "architecture" } }] };
    const receipts = await retainBlockerContract({ job, fileService: fixture.base.fileService });
    const original = await fixture.base.fileService.readFile({ path: receipts[0].path });
    assert.equal((await readBlockerContracts({ receipts, fileService: fixture.base.fileService, binding })).length, 1);
    for (const field of ["project_id", "sprint_id", "plan_id", "plan_revision", "plan_path", "plan_sha256", "version"]) {
      const changed = { ...basis, [field]: typeof basis[field] === "number" ? 2 : "changed" };
      await assert.rejects(readBlockerContracts({ receipts, fileService: fixture.base.fileService, binding: { ...binding, sprint_basis: changed } }), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" });
    }
    for (const field of ["project_id", "task_id", "execution_id"]) {
      await assert.rejects(readBlockerContracts({ receipts, fileService: fixture.base.fileService, binding: { ...binding, [field]: "FOREIGN" } }), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" });
    }
    assert.equal(await fixture.base.fileService.readFile({ path: receipts[0].path }), original);
  } finally { await fixture.close(); }
});
