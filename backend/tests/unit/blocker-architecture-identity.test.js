// Preserves architecture identity and scope checks in a focused test file so authority routing tests remain within the source budget.
import assert from "node:assert/strict";
import test from "node:test";
import { approvedBlockerArchitecture, assertArchitectureDisposition } from "../../src/modules/supervisor/blocker/blocker-decision-authority.js";

// Supplies the unchanged approved architecture evidence used by the identity assertions.
const boundaryQuote = "Reuse the existing in-process worker topology and public interfaces without changing system structure.";
// Identifies the approved parent revision for cross-project and checksum isolation checks.
const basis = { plan_id: "ARCH-PLAN", revision: 1, sha256: "a".repeat(64) };
// Keeps the original all-false boundary assessment used to reject unsupported authority claims.
const assessment = { rationale: "Use a compatible internal adapter; retain all owner constraints and ticket criteria.", changes_structure: false,
  changes_owner_scope: false, changes_security_policy: false, changes_data_semantics: false, overrides_guardrails: false, changes_ticket_contract: false };
test("Architecture authority rejects cross-project, source-path and parent-checksum mismatches", async () => {
  const plan = { proposal_id: `${basis.plan_id}-R1-${basis.sha256}`, source_path: "architecture.md", source_sha256: basis.sha256 };
  const parent = { ...basis, project_id: "P", file_path: plan.source_path, markdown: boundaryQuote };
  for (const changes of [{ project_id: "OTHER" }, { file_path: "other.md" }, { sha256: "b".repeat(64) }, { revision: 2 }]) {
    await assert.rejects(approvedBlockerArchitecture(plan, "P", { assertApproved: async () => ({ ...parent, ...changes }) }),
      { code: "BLOCKER_DISPOSITION_INVALID" });
  }
});

test("SL cannot claim AM authority and AM cannot resolve without the approved parent and impact assessment", () => {
  const value = { authority_quote: boundaryQuote, architecture_basis: basis, boundary_assessment: assessment };
  const architecture = { basis, markdown: boundaryQuote };
  for (const context of [{ job: { stage: "sprint_leader" }, architecture }, { job: { stage: "architecture_manager" }, architecture: null }]) {
    assert.throws(() => assertArchitectureDisposition(value, context), { code: "BLOCKER_DISPOSITION_INVALID" });
  }
  assert.throws(() => assertArchitectureDisposition({ ...value, boundary_assessment: null },
    { job: { stage: "architecture_manager" }, architecture }), { code: "BLOCKER_DISPOSITION_INVALID" });
});

test("Architecture identity failures report each precise field instead of one combined error", () => {
  for (const field of ["plan_id", "revision", "sha256"]) {
    assert.throws(() => assertArchitectureDisposition({ authority_scope: "architecture", authority_quote: boundaryQuote, boundary_assessment: assessment,
      architecture_basis: { ...basis, [field]: field === "revision" ? 2 : "wrong" } },
    { job: { stage: "architecture_manager" }, architecture: { basis, markdown: boundaryQuote } }),
    (error) => error.validation_errors[0].path === `/architecture_basis/${field}` && error.retryable_disposition === true);
  }
  assert.throws(() => assertArchitectureDisposition({ authority_scope: "architecture", authority_quote: boundaryQuote, boundary_assessment: assessment, architecture_basis: {} },
    { job: { stage: "architecture_manager" }, architecture: { basis, markdown: boundaryQuote } }),
  (error) => { assert.deepEqual(error.validation_errors.map((entry) => entry.path), ["/architecture_basis/plan_id", "/architecture_basis/revision", "/architecture_basis/sha256"]); return true; });
});
