// Verifies bounded automatic disposition correction preserves rejected evidence without weakening execution authority.
import assert from "node:assert/strict";
import test from "node:test";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { blockerAuthorityPassages, resolveBlockerAuthority } from "../../src/modules/supervisor/blocker-authority-passages.js";
import { blockerResponseEvidence } from "../../src/modules/supervisor/blocker-validation.js";
import { repeatedDispositionCorrection, blockerCorrectionPrompt } from "../../src/modules/supervisor/blocker-disposition-correction.js";

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

test("changing invalid inputs can be corrected beyond a legacy call quota without resetting the checkpoint", async () => {
  let attempt = 0;
  const fixture = await blockerRecoveryFixture({ limits: { maxCalls: 2 }, investigate: async (_job, resolution) => ++attempt <= 10
    ? { ...resolution, evidence: [{ ...resolution.evidence[0], sha256: attempt.toString(16).repeat(64) }] } : resolution });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    for (let turn = 0; turn < 10; turn += 1) await fixture.recreate().tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "pending");
    await fixture.recovery.tick();
    await fixture.recovery.tick();
    const ledger = await fixture.ledger();
    assert.equal(ledger.calls, 11);
    assert.equal(ledger.resumes, 1);
    assert.equal(ledger.jobs[0].status, "resumed");
    assert.equal(ledger.jobs[0].disposition_attempts.length, 11);
    assert.equal(fixture.base.invocations, 2);
    assert.equal(fixture.base.events.filter((event) => event.type.includes("owner_decision_required")).length, 0);
  } finally { await fixture.close(); }
});

test("unchanged validation failures stop replaying across restart even if SL rewrites its summary", async () => {
  let attempt = 0;
  const fixture = await blockerRecoveryFixture({ investigate: async (_job, resolution) => ({ ...resolution,
    summary: `Reworded reply ${++attempt}`, guidance: "" }) });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    const before = await fixture.base.checkpoints.load("TASK");
    await fixture.recovery.tick();
    await fixture.recreate().tick();
    assert.equal((await fixture.ledger()).jobs[0].outcome_reason, "disposition_correction_no_progress");
    for (let count = 0; count < 3; count += 1) await fixture.recreate().tick();
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.base.invocations, 1);
    assert.equal((await fixture.base.checkpoints.load("TASK")).last_completed_turn, before.last_completed_turn);
  } finally { await fixture.close(); }
});

test("new source evidence or a changed invalid field can be corrected without a global attempt limit", () => {
  const job = { id: "J", stage: "sprint_leader", ticket_progress: { evidence_sha256: "SOURCE-1" }, disposition_attempts: [] };
  const feedback = [{ path: "/guidance", reason: "guidance_invalid" }];
  // Appends provider evidence exactly as the durable worker does before checking for repeated invalid fields.
  const record = (guidance) => job.disposition_attempts.push({ assignment_id: "ASSIGNMENT", stage: "sprint_leader",
    status: "rejected", response: blockerResponseEvidence({ action: "resolved", summary: `Reply ${job.disposition_attempts.length}`, guidance }) });
  record("");
  assert.equal(repeatedDispositionCorrection(job, feedback), false);
  job.ticket_progress.evidence_sha256 = "SOURCE-2";
  record("");
  assert.equal(repeatedDispositionCorrection(job, feedback), false);
  record("x".repeat(8001));
  assert.equal(repeatedDispositionCorrection(job, feedback), false);
  record("");
  assert.equal(repeatedDispositionCorrection(job, feedback), true);
});

test("different malformed JSON responses at root are not collapsed into the same null-valued failure", () => {
  const job = { id: "J", stage: "architecture_manager", disposition_attempts: [] };
  const feedback = [{ path: "/", reason: "json_invalid", message: "Unclosed object." }];
  for (const [text, repeated] of [["{\"kind\":", false], ["{\"kind\":\"consultation_response\",\"payload\":{", false],
    ["{\"kind\":\"consultation_response\",\"payload\":{", true]]) {
    job.disposition_attempts.push({ assignment_id: "A", stage: job.stage, status: "rejected", response: blockerResponseEvidence(text) });
    assert.equal(repeatedDispositionCorrection(job, feedback), repeated);
  }
  const prompt = blockerCorrectionPrompt({ ...job, validation_feedback: feedback });
  assert.match(prompt, /JSON RESPONSE CORRECTION/);
  assert.match(prompt, /current Node capability facts/);
  assert.doesNotMatch(prompt, /resolved technical handoff/);
});

test("an unchanged failure may recur after partial progress without stopping SL with no-progress", () => {
  // Mirrors the READ-WINDOW-SL timeline: missing technical_result, then stale
  // checksum (a different field), then missing technical_result again with the
  // same source and assignment. The later reply improved evidence and must get
  // another correction round instead of being classified as giậm chân.
  const job = { id: "J", stage: "sprint_leader", ticket_progress: { evidence_sha256: "SOURCE-1" }, disposition_attempts: [] };
  const record = (response) => job.disposition_attempts.push({ assignment_id: "ASSIGNMENT", stage: "sprint_leader",
    status: "rejected", response: blockerResponseEvidence(response) });

  record({ action: "resolved" });
  assert.equal(repeatedDispositionCorrection(job, [{ path: "/technical_result", reason: "technical_result_incomplete" }]), false);

  // The second reply includes a technical_result but the evidence checksum is stale.
  record({ action: "resolved", technical_result: { findings: ["x"], implementation_steps: ["y"], verification_steps: ["z"],
    admission: { status: "within_existing_permissions", rationale: "existing" } }, evidence: [{ path: "src/a.js", sha256: "old" }] });
  assert.equal(repeatedDispositionCorrection(job, [{ path: "/evidence/0/sha256", reason: "evidence_stale" }]), false);

  // The third reply fixes the checksum but omits technical_result again. Same
  // fingerprint as the first attempt, yet it is not adjacent to it, so this is
  // an opportunity to correct, not no-progress.
  record({ action: "resolved", evidence: [{ path: "src/a.js", sha256: "f".repeat(64) }] });
  assert.equal(repeatedDispositionCorrection(job, [{ path: "/technical_result", reason: "technical_result_incomplete" }]), false);

  // Only an immediately repeated identical failure parks the SL handoff.
  record({ action: "resolved", evidence: [{ path: "src/a.js", sha256: "f".repeat(64) }] });
  assert.equal(repeatedDispositionCorrection(job, [{ path: "/technical_result", reason: "technical_result_incomplete" }]), true);
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
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "reconciliation_required");
    assert.match((await fixture.ledger()).jobs[0].last_error, /approved contract evidence/);
  } finally { await fixture.close(); }
});
