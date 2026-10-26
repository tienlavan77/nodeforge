/** Verifies checksum repair uses trusted whole-file metadata while preserving
 * approved planning scope, original drafts, and existing contract baselines. */
import assert from "node:assert/strict";
import test from "node:test";
import { repairSprintContractEvidence } from "../../src/modules/governance/sprint-contract-evidence.js";

/** Supplies a draft whose unrelated planning fields must survive every repair. */
function draft(sha256 = "e".repeat(65)) {
  return { id: "SPRINT-EVIDENCE", objective: "Keep the approved scope", tickets: [{
    id: "TICKET-EVIDENCE", acceptance_criteria: ["Keep the source contract"], dependencies: [],
    execution_policy: { requires_existing_contract: true, contract_evidence: [{ path: "backend/src/example.js", sha256,
      authority_quote: "Preserve the existing approved source contract." }] },
  }] };
}

// Uses only the whole-file read checksum, never a hash of the returned window or stale index.
test("repairs a malformed digest from the request receipt without rereading", async () => {
  const original = draft(); const frozen = structuredClone(original);
  const receipts = new Map([["backend/src/example.js", { path: "backend/src/example.js", sha256: `sha256:${"a".repeat(64)}`, indexed_sha256: `sha256:${"b".repeat(64)}`, content: "one source line" }]]);
  const repaired = await repairSprintContractEvidence(original, { readReceipts: receipts, readFile: () => assert.fail("Must reuse the receipt") });
  const expected = structuredClone(original); expected.tickets[0].execution_policy.contract_evidence[0].sha256 = "a".repeat(64);
  assert.deepEqual(repaired, expected); assert.deepEqual(original, frozen);
});

// A fresh authorized read recovers legacy drafts and is deduplicated by source identity.
test("repairs a retained draft with one metadata read per path", async () => {
  const original = draft(); original.tickets.push(structuredClone(original.tickets[0]));
  const reads = [];
  const repaired = await repairSprintContractEvidence(original, { readFile: async (path) => {
    reads.push(path); return { path, sha256: `sha256:${"c".repeat(64)}` };
  } });
  assert.deepEqual(reads, ["backend/src/example.js"]);
  for (const ticket of repaired.tickets) assert.equal(ticket.execution_policy.contract_evidence[0].sha256, "c".repeat(64));
});

// Schema-valid historical bindings remain intact even when the current source differs.
test("does not refresh a valid baseline or create missing evidence", async () => {
  const original = draft("d".repeat(64));
  const readFile = () => assert.fail("A valid baseline must not be refreshed");
  assert.equal(await repairSprintContractEvidence(original, { readFile }), original);
  const empty = { tickets: [{ execution_policy: { requires_existing_contract: true, contract_evidence: [] } }, {}] };
  assert.equal(await repairSprintContractEvidence(empty, { readFile }), empty);
  assert.equal(await repairSprintContractEvidence(undefined), undefined);
});

// A prefixed hash must still come from an authorized receipt rather than provider text.
test("normalizes sha256 prefixes using trusted source metadata", async () => {
  const original = draft(`sha256:${"b".repeat(64)}`);
  const repaired = await repairSprintContractEvidence(original, { readFile: async (path) => ({ path, sha256: `sha256:${"a".repeat(64)}` }) });
  assert.equal(repaired.tickets[0].execution_policy.contract_evidence[0].sha256, "a".repeat(64));
});

// Metadata that cannot prove the exact file must never manufacture a usable evidence binding.
test("rejects absent, malformed, or wrong-path receipts", async () => {
  for (const receipt of [undefined, { path: "backend/src/example.js", sha256: "short" }, { path: "backend/src/other.js", sha256: "a".repeat(64) }]) {
    const original = draft(); const frozen = structuredClone(original);
    await assert.rejects(repairSprintContractEvidence(original, { readFile: async () => receipt }), { code: "SPRINT_CONTRACT_EVIDENCE_REQUIRED" });
    assert.deepEqual(original, frozen);
  }
});

// Access errors propagate and partial in-memory repair cannot mutate the durable candidate.
test("preserves the original draft when a later source read is forbidden", async () => {
  const original = draft(); original.tickets[0].execution_policy.contract_evidence.push({ path: "backend/secrets/token.js", sha256: "invalid", authority_quote: "Do not broaden file access" });
  const frozen = structuredClone(original);
  await assert.rejects(repairSprintContractEvidence(original, { readFile: async (path) => {
    if (path.includes("secrets")) throw Object.assign(new Error("Forbidden"), { code: "FILE_ROLE_FORBIDDEN" });
    return { path, sha256: "a".repeat(64) };
  } }), { code: "FILE_ROLE_FORBIDDEN" });
  assert.deepEqual(original, frozen);
});
