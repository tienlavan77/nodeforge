// Prevents approved Architecture contract evidence from blocking ticket launch while retaining exact authority and source checks.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

const quote = "The lifecycle manager owns project runtimes; the CLI is only a thin management client.";
const sha256 = createHash("sha256").update(quote).digest("hex");
const parent = { plan_id: "ARCHITECTURE", revision: 1, project_id: "P", sha256,
  file_path: "plans/architecture.md", markdown: quote };

// Builds a ticket whose contract quote exists only in its authenticated Architecture parent.
async function architectureFixture({ approvedParent = parent, evidence = {}, architecturePlans } = {}) {
  const calls = [];
  const fixture = await blockerRecoveryFixture({ ticket: { execution_policy: {
    requires_existing_contract: true, contract_evidence: [{ path: "backend/src/handler.js",
      sha256: createHash("sha256").update("export const approvedHandler = true;\n").digest("hex"),
      authority_quote: quote, ...evidence }] } }, recoveryOptions: { architecturePlans: architecturePlans ?? {
    assertApproved: async (basis) => { calls.push(basis); return approvedParent; }
  } } });
  const assertReady = fixture.base.registry.assertReady;
  fixture.base.registry.assertReady = async (...args) => {
    const ready = await assertReady(...args);
    return { ...ready, plan: { ...ready.plan, proposal_id: `ARCHITECTURE-R1-${sha256}`,
      source_path: parent.file_path, source_sha256: sha256 } };
  };
  return { ...fixture, authorityCalls: calls };
}

test("approved parent contract evidence reaches Coder without a false preflight blocker", async () => {
  const fixture = await architectureFixture();
  try {
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    assert.equal(fixture.base.invocations, 1);
    assert.deepEqual(fixture.authorityCalls[0], { planId: "ARCHITECTURE", revision: 1, sha256 });
  } finally { await fixture.close(); }
});

test("valid Architecture evidence is checked without launching Sprint Leader or Architecture models", async () => {
  const fixture = await architectureFixture();
  try {
    const blocked = await fixture.recovery.preflight({ ticket: fixture.ticket, task_id: "TASK", project_id: "P",
      payload: { sprint_basis: fixture.base.statusStore.get().details.execution_basis } });
    assert.equal(blocked, false);
    await fixture.recovery.tick();
    assert.equal(await fixture.ledger(), undefined);
    assert.deepEqual(fixture.calls, []);
    assert.equal(fixture.base.invocations, 0);
    assert.equal(fixture.base.events.some((event) => event.type === "task.needs_human_review"), false);
    assert.deepEqual(fixture.authorityCalls, [{ planId: "ARCHITECTURE", revision: 1, sha256 }]);
  } finally { await fixture.close(); }
});

for (const field of ["project_id", "plan_id", "revision", "sha256", "file_path"]) {
  test(`Architecture contract preflight rejects a mismatched parent ${field}`, async () => {
    const fixture = await architectureFixture({ approvedParent: { ...parent, [field]: field === "revision" ? 2 : "different" } });
    try {
      assert.equal((await fixture.base.run()).status, "needs_human_review");
      assert.equal(fixture.base.invocations, 0);
    } finally { await fixture.close(); }
  });
}

for (const evidence of [{ authority_quote: "An invented authority quote must not grant permission to launch." }, { sha256: "0".repeat(64) }]) {
  test(`Architecture contract preflight rejects ungrounded or stale ${Object.keys(evidence)[0]}`, async () => {
    const fixture = await architectureFixture({ evidence });
    try {
      assert.equal((await fixture.base.run()).status, "needs_human_review");
      assert.equal(fixture.base.invocations, 0);
    } finally { await fixture.close(); }
  });
}

test("unavailable Architecture approval cannot authorize a contract quote", async () => {
  const fixture = await architectureFixture({ architecturePlans: {} });
  try {
    assert.equal((await fixture.base.run()).status, "needs_human_review");
    assert.equal(fixture.base.invocations, 0);
  } finally { await fixture.close(); }
});
