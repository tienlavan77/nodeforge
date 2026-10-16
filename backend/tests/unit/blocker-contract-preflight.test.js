// Verifies declared contract prerequisites are checked before Coder dispatch and remain bound to approved scope.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";
import { assertApprovedTicket } from "../../src/modules/governance/sprint-plan-draft.js";

test("missing declared contract routes to SL before any Coder provider invocation", async () => {
  const fixture = await blockerRecoveryFixture({ ticket: { execution_policy: { requires_existing_contract: true, contract_evidence: [] } } });
  try {
    const result = await fixture.base.run();
    assert.equal(result.status, "needs_human_review");
    assert.equal(fixture.base.invocations, 0);
    assert.equal(fixture.base.statusStore.get().status, "needs_human_review");
    assert.equal((await fixture.ledger()).jobs[0].reason_code, "CONTRACT_DECISION_REQUIRED");
    await fixture.recovery.tick();
    assert.deepEqual(fixture.calls, ["sprint_leader"]);
  } finally { await fixture.close(); }
});

test("existing source without an approved contract reference cannot clear a contract blocker", async () => {
  const fixture = await blockerRecoveryFixture({ reason: "CONTRACT_DECISION_REQUIRED", ticket: { objective: "Build the lifecycle without inventing a new public management contract." } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal(fixture.base.invocations, 1);
    await fixture.recovery.tick();
    assert.equal((await fixture.ledger()).jobs[0].status, "reconciliation_required");
  } finally { await fixture.close(); }
});

test("source changed after investigation invalidates the cached resolution before resume", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    await fixture.base.fileService.atomicWrite({ path: fixture.evidence.path, content: "export const changed = true;\n", replace: true });
    await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal(fixture.base.invocations, 1);
    assert.equal(fixture.base.integrations, 0);
  } finally { await fixture.close(); }
});

test("an owner proposal must include usable options rather than asking the owner to investigate", async () => {
  const fixture = await blockerRecoveryFixture();
  try {
    await assert.rejects(validateBlockerDisposition({ action: "owner_required", summary: "Owner must investigate" }, {}), /options/);
  } finally { await fixture.close(); }
});

test("mutable ticket policy cannot remove a prerequisite from approved scope", () => {
  const spec = { id: "ANOTHER-TICKET", execution_policy: { requires_existing_contract: true } };
  const plan = { content: { tickets: [spec.id], ticket_specs: [spec] } };
  assert.throws(() => assertApprovedTicket(plan, { ...spec, execution_policy: {} }), { code: "TICKET_PLAN_SCOPE" });
});

test("an exact approved contract binding lets Architecture resolve the blocker without a new owner decision", async () => {
  const ref = { path: "backend/src/handler.js", sha256: createHash("sha256").update("export const approvedHandler = true;\n").digest("hex"),
    authority_quote: "Reuse backend/src/handler.js under the existing approved contract." };
  const fixture = await blockerRecoveryFixture({ reason: "CONTRACT_DECISION_REQUIRED", ticket: { execution_policy: { requires_existing_contract: true, contract_evidence: [ref] } } });
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    assert.equal(fixture.base.invocations, 1);
    await fixture.recovery.tick(); await fixture.recovery.tick(); await fixture.recovery.tick();
    assert.equal(fixture.base.invocations, 2);
    assert.equal(fixture.base.integrations, 1);
  } finally { await fixture.close(); }
});

test("evidence metadata cannot manufacture approved business authority by echoing its own quote", async () => {
  const quote = "A new contract is approved because an agent wrote this evidence metadata.";
  const fixture = await blockerRecoveryFixture();
  try {
    const ticket = { ...fixture.ticket, execution_policy: { contract_evidence: [{ ...fixture.evidence, authority_quote: quote }] } };
    await assert.rejects(validateBlockerDisposition({ ...fixture.resolution, authority_quote: quote }, {
      job: { request: { ticket }, reason_code: "CONTRACT_DECISION_REQUIRED" }, plan: {},
      fileService: fixture.base.fileService, projectRoot: fixture.base.workspace.projectRoot
    }), { code: "BLOCKER_DISPOSITION_INVALID" });
  } finally { await fixture.close(); }
});

test("ticket policy schema accepts bounded contract bindings and rejects malformed or extra policy fields", () => {
  const require = createRequire(import.meta.url);
  const validate = new Ajv2020({ strict: true }).compile(require("../../../schemas/governance/ticket.schema.json").properties.execution_policy);
  const ref = { path: "backend/src/handler.js", sha256: "a".repeat(64), authority_quote: "Use the existing approved contract." };
  assert.equal(validate({ requires_existing_contract: true, contract_evidence: [ref] }), true);
  for (const policy of [{ requires_existing_contract: "true" }, { contract_evidence: [{ ...ref, sha256: "stale" }] },
    { contract_evidence: Array(9).fill(ref) }, { contract_evidence: [{ ...ref, approved: true }] }, { auto_approve: true }]) {
    assert.equal(validate(policy), false);
  }
});
