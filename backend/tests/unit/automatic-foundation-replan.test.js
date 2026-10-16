// Verifies automatic foundation replanning creates one approved successor and never changes the blocked transport ticket.
import assert from "node:assert/strict";
import test from "node:test";
import { createAutomaticFoundationReplan } from "../../src/modules/supervisor/automatic-foundation-replan.js";

const source = { plan_id: "ARCH", revision: 1, sha256: "a".repeat(64) };
const ticket = { id: "TICKET-MULTIPROJECT-A-R1-LIFECYCLE", project_id: "P", sprint_id: "SPRINT-A", title: "Multi-project lifecycle",
  objective: "Implement lifecycle and transport.", acceptance_criteria: ["Foundation", "Transport"], verification_plan: [{ kind: "test", test_path: "backend/tests/foundation.test.js" }, { kind: "human", notes: "Owner" }],
  execution_policy: { requires_existing_contract: true, contract_evidence: [{ path: "contract.md", sha256: "b".repeat(64), authority_quote: "Existing approved contract evidence" }], review_gate: "on", max_review_revisions: 2 } };

// Supplies deterministic persistence seams for the automatic replan contract.
function fixture(dispatch) {
  const records = new Map(); let revision;
  const plans = { createRevision: async (input) => { revision = { ...input, revision: 1, sha256: "c".repeat(64), file_path: "foundation.json" }; return revision; },
    approveDerived: async (input) => { records.set("approved", input); } };
  const sprintRegistry = { list: () => [], get: () => undefined, register: async (input) => { records.set("registered", input); return { ...input, project_id: "P", version: 1, plan_path: "foundation.json", plan_sha256: revision.sha256 }; },
    setStatus: async (input) => ({ ...records.get("registered"), ...input, status: "ready", plan_id: revision.planId, plan_revision: 1, plan_path: "foundation.json", plan_sha256: revision.sha256 }) };
  const ticketStatusStore = { create: (id, details) => { records.set("status", { id, details, status: "pending" }); return records.get("status"); } };
  return { records, plans, sprintRegistry, ticketStatusStore, markdownPlans: { assertApproved: async () => ({}) }, dispatch };
}

test("AM owner escalation automatically prepares and dispatches a foundation successor", async () => {
  const calls = []; const base = fixture(async (input) => { calls.push(input); return { status: "accepted" }; });
  const replan = createAutomaticFoundationReplan({ ...base, projectId: "P" });
  const result = await replan.prepare({ job: { request: { ticket } }, plan: { proposal_id: "ARCH-R1-" + source.sha256, source_path: "plan.md", source_sha256: source.sha256,
    content: { objective: "Original", out_of_scope: "UI" } }, architecture: { basis: source } });
  assert.equal(result.dispatched, true); assert.equal(calls.length, 1);
  assert.match(result.ticket_id, /-FOUNDATION$/); assert.equal(base.records.get("status").status, "pending");
  assert.equal(base.records.get("approved").markdownPlanId, "ARCH");
  assert.equal(base.records.get("registered").status, "planned");
  assert.equal(calls[0].ticket.execution_policy.requires_existing_contract, false);
  assert.deepEqual(calls[0].ticket.execution_policy.contract_evidence, []);
  assert.equal(calls[0].ticket.verification_plan.length, 1);
});

test("same source and ticket are idempotent and never create a second foundation sprint", async () => {
  const base = fixture(); let existing = false; base.sprintRegistry.get = () => existing ? {} : undefined;
  const originalRegister = base.sprintRegistry.register; base.sprintRegistry.register = async (...args) => { existing = true; return originalRegister(...args); };
  const replan = createAutomaticFoundationReplan({ ...base, projectId: "P" });
  const input = { job: { request: { ticket } }, plan: { proposal_id: "ARCH-R1-" + source.sha256, source_path: "plan.md", source_sha256: source.sha256, content: {} }, architecture: { basis: source } };
  const first = await replan.prepare(input); const second = await replan.prepare(input);
  assert.equal(first.sprint_id, second.sprint_id); assert.equal(second.status, "existing");
});
