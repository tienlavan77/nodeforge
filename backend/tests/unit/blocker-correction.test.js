// Verifies bounded automatic disposition correction preserves rejected evidence without weakening execution authority.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { blockerAuthorityPassages, resolveBlockerAuthority } from "../../src/modules/supervisor/blocker-authority-passages.js";
import { blockerResponseEvidence } from "../../src/modules/supervisor/blocker-validation.js";

test("SL receives actionable correction feedback and cannot resume until the full disposition validates", async () => {
  let attempts = 0;
  const fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
    attempts += 1;
    if (attempts === 1) return { ...resolution, guidance: "" };
    assert.equal(job.validation_feedback[0].path, "/guidance");
    const ledger = await fixture.ledger();
    assert.equal(ledger.jobs[0].disposition_attempts[0].status, "rejected");
    assert.equal(JSON.parse(ledger.jobs[0].disposition_attempts[0].response.text).guidance, "");
    return resolution;
  } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick();
    assert.equal(fixture.base.invocations, 1);
    await fixture.recovery.tick(); await fixture.recovery.tick();
    const job = (await fixture.ledger()).jobs[0];
    assert.equal(job.status, "resumed");
    assert.equal(job.validation_feedback, undefined);
    assert.deepEqual(job.disposition_attempts.map((entry) => entry.status), ["rejected", "accepted"]);
    assert.equal(fixture.base.integrations, 1);
  } finally { await fixture.close(); }
});

test("persistent disposition errors exhaust the original call budget across restart, without owner escalation", async () => {
  const fixture = await blockerRecoveryFixture({ limits: { maxCalls: 2 }, investigate: async (_job, resolution) => ({ ...resolution, guidance: "" }) });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recreate().tick(); await fixture.recovery.tick();
    const ledger = await fixture.ledger();
    assert.equal(ledger.calls, 2);
    assert.equal(ledger.resumes, 0);
    assert.equal(ledger.jobs[0].status, "reconciliation_required");
    assert.equal(ledger.jobs[0].outcome_reason, "disposition_correction_budget_exhausted");
    assert.equal(ledger.jobs[0].disposition_attempts.length, 2);
    assert.equal(fixture.base.invocations, 1);
    assert.equal(fixture.base.events.filter((event) => event.type.includes("owner_decision_required")).length, 0);
  } finally { await fixture.close(); }
});

test("deadline and Stop cancel further correction without resetting checkpoints or invocation ownership", async () => {
  for (const stop of [false, true]) {
    const fixture = await blockerRecoveryFixture({ limits: { deadlineMs: 1000 }, investigate: async (_job, resolution) => ({ ...resolution, guidance: "" }) });
    try {
      await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
      await fixture.recovery.tick();
      if (stop) await fixture.recovery.stopTicket({ projectId: "P", ticketId: "TASK" });
      else fixture.advance(1000);
      await fixture.recreate().tick();
      assert.equal(fixture.calls.length, 1);
      assert.equal(fixture.base.invocations, 1);
      assert.equal((await fixture.base.checkpoints.load("TASK")).status, "blocked");
      assert.equal((await fixture.ledger()).jobs[0].status, stop ? "cancelled" : "reconciliation_required");
    } finally { await fixture.close(); }
  }
});

test("paraphrasing requires a current same-scope reference and cannot reuse a stale or invented authority", () => {
  const context = { plan: { content: {} }, ticket: { objective: "Retain the existing project topology and all public interfaces." },
    architecture: { basis: { plan_id: "P", revision: 1, sha256: "a".repeat(64) }, markdown: "Do not add a public API or change the approved worker topology." } };
  const passages = blockerAuthorityPassages(context);
  const passage = passages.find((entry) => entry.scope === "architecture");
  const value = { authority_scope: "architecture", authority_quote: "Giữ nguyên cấu trúc và không thêm API.",
    authority_reference: { passage_id: passage.passage_id, rationale: "Reuse existing internal components without adding public operations or changing topology." } };
  assert.equal(resolveBlockerAuthority(value, context), context.architecture.markdown);
  for (const changed of [{ ...value, authority_scope: "sprint" }, { ...value, authority_reference: { ...value.authority_reference, passage_id: "invented" } }]) {
    assert.throws(() => resolveBlockerAuthority(changed, context), { code: "BLOCKER_DISPOSITION_INVALID" });
  }
  assert.throws(() => resolveBlockerAuthority(value, { ...context, architecture: { ...context.architecture, basis: { ...context.architecture.basis, revision: 2 } } }),
    { code: "BLOCKER_DISPOSITION_INVALID" });
});

test("rejected response evidence is bounded and retains a digest instead of growing the recovery ledger indefinitely", () => {
  const evidence = blockerResponseEvidence("x".repeat(60_000));
  assert.equal(Buffer.byteLength(evidence.text), 48_000);
  assert.equal(evidence.truncated, true);
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
});

test("an approved passage and paraphrase cannot manufacture the existing-contract approval prerequisite", async () => {
  const fixture = await blockerRecoveryFixture({ reason: "CONTRACT_DECISION_REQUIRED", investigate: async (job, resolution) => ({ ...resolution,
    authority_quote: "Use the current internal handler without changing the interface.",
    authority_reference: { passage_id: job.authority_context.passages.find((entry) => entry.scope === "sprint").passage_id,
      rationale: "The Sprint authorizes reuse of the internal handler; this is not a public transport contract approval." } }) });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal(fixture.base.invocations, 1);
    assert.equal(fixture.base.integrations, 0);
    assert.equal((await fixture.ledger()).jobs[0].status, "reconciliation_required");
    assert.match((await fixture.ledger()).jobs[0].last_error, /approved contract evidence/);
  } finally { await fixture.close(); }
});
