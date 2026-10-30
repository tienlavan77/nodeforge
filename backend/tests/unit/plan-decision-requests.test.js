// Verifies Sprint policy proposals, exact owner choices, pre-dispatch blocking and Coder evidence without live executions.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import { planDecisionRequests, validatePlanDecisionSelections, assertPlanOwnerDecisions, approvedTicketDecisions, hasOwnerDecisionEvidence } from "../../src/modules/governance/plan-decision-requests.js";
import { completeNodeReportEvidence } from "../../src/tools/reporting/node-report-evidence.js";
import { buildCodexTicketPrompt } from "../../src/modules/supervisor/nodeforge-task-prompts.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";
import { sprintPlanDraftContent } from "../../src/modules/governance/sprint-plan-draft.js";
import { routePlan } from "../../src/transport/http/forge-v1-plan-routes.js";

const ticket = { id: "TICKET-A", title: "Restore panels", project_id: "PROJECT-A", sprint_id: "SPRINT-A", acceptance_criteria: ["Owner chooses storage", "Panels survive reload"], verification_plan: [{ kind: "human", criterion_ids: ["AC-1"], assertions: ["Choose storage before admission"] }] };
const request = { id: "STORAGE", title: "Storage scope", reason: "Restore panels after reload", ticket_ids: [ticket.id], criterion_ids: ["AC-1"], options: [{ id: "LOCAL", label: "Browser-local", description: "Project-scoped metadata only; no credentials or activity history." }, { id: "SESSION", label: "Session only", description: "No durable restoration across browser restarts." }], recommended_option_id: "LOCAL" };
const content = { tickets: [ticket.id], ticket_specs: [ticket], decision_requests: [request] };

// Builds an exact approval snapshot without treating the SL recommendation as authorization.
function plan() {
  return { plan_id: "PLAN-A", project_id: "PROJECT-A", sprint_id: "SPRINT-A", revision: 1, sha256: "a".repeat(64), content: structuredClone(content), status: "approved", decision: { decision_id: "OWNER-1", plan_id: "PLAN-A", revision: 1, sha256: "a".repeat(64), approver_id: "OWNER", decision: "approved", selections: { STORAGE: "LOCAL" } } };
}

test("omitted human prerequisites become visible unresolved requests, never implicit approvals", () => {
  const requests = planDecisionRequests({ ticket_specs: [ticket] });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].criterion_ids, ["AC-1"]);
  assert.deepEqual(requests[0].options, []);
  assert.throws(() => validatePlanDecisionSelections(requests, {}), { code: "PLAN_DECISION_PROPOSALS_REQUIRED" });
});

test("owner must explicitly choose supported options; recommendations and foreign requests are not approval", () => {
  const requests = planDecisionRequests(content);
  assert.throws(() => validatePlanDecisionSelections(requests), { code: "PLAN_OWNER_DECISIONS_REQUIRED" });
  assert.throws(() => validatePlanDecisionSelections(requests, { STORAGE: "UNKNOWN" }), { code: "PLAN_OWNER_DECISIONS_REQUIRED" });
  assert.throws(() => validatePlanDecisionSelections(requests, { STORAGE: "LOCAL", FOREIGN: "YES" }), { code: "PLAN_DECISION_SELECTION_INVALID" });
  assert.deepEqual(validatePlanDecisionSelections(requests, { STORAGE: "LOCAL" }), { STORAGE: "LOCAL" });
});

test("invalid duplicate, cross-ticket and out-of-range proposals are rejected", () => {
  for (const mutation of [
    (value) => value.decision_requests.push(request),
    (value) => { value.decision_requests[0].ticket_ids = ["FOREIGN"]; },
    (value) => { value.decision_requests[0].criterion_ids = ["AC-9"]; },
    (value) => { value.decision_requests[0].recommended_option_id = "UNKNOWN"; }
  ]) {
    const value = structuredClone(content); mutation(value);
    assert.throws(() => planDecisionRequests(value), { code: "PLAN_DECISION_PROPOSALS_INVALID" });
  }
});

test("approval choices cannot carry over to another plan, revision, hash or approver", () => {
  assert.doesNotThrow(() => assertPlanOwnerDecisions(plan()));
  for (const patch of [{ plan_id: "PLAN-B" }, { revision: 2 }, { sha256: "b".repeat(64) }, { decision: null }, { status: "awaiting_human_approval" }]) {
    assert.throws(() => assertPlanOwnerDecisions({ ...plan(), ...patch }), { code: "PLAN_OWNER_DECISIONS_REQUIRED" });
  }
  const value = plan(); value.decision.approver_id = null;
  assert.throws(() => assertPlanOwnerDecisions(value), { code: "PLAN_OWNER_DECISIONS_REQUIRED" });
});

test("choices reach Coder and human evidence only under Node's matching plan identity", () => {
  const approved = plan();
  const bound = { ...ticket, owner_decisions: approvedTicketDecisions(approved, ticket.id), owner_decision_basis: { plan_id: approved.plan_id, revision: 1, sha256: approved.sha256, decision_id: "OWNER-1" } };
  assert.equal(hasOwnerDecisionEvidence(bound, "AC-1"), true);
  assert.equal(hasOwnerDecisionEvidence({ ...bound, owner_decision_basis: { ...bound.owner_decision_basis, revision: 2 } }, "AC-1"), false);
  const evidence = completeNodeReportEvidence({}, bound, { artifact_id: "ARTIFACT-A", file_checksums: {}, commands: [] });
  assert.equal(evidence.acceptance_coverage[0].status, "verified");
  assert.equal(evidence.acceptance_coverage[0].command_kind, "human");
  assert.equal(completeNodeReportEvidence({}, ticket, { commands: [] }).acceptance_coverage[0].status, "evidence_pending");
  assert.match(buildCodexTicketPrompt(bound, "", [], {}, false, false), /Owner-approved policy decisions.*Browser-local/s);
});

test("RUN refuses missing owner selections before beginning execution, clearing state or dispatching", async () => {
  const approved = plan(); approved.decision.selections = {};
  const dispatch = createTicketRunDispatch({ disposition: { get: async () => null }, intake: { open: async () => ({ ticket: structuredClone(ticket) }) }, sprintRegistry: { get: () => ({}), assertReady: async () => ({ plan: approved, sprint: {} }) }, ticketStatusStore: { beginExecution: () => assert.fail("Must not claim execution") }, dispatchTask: () => assert.fail("Must not dispatch Coder") });
  await assert.rejects(dispatch({ projectId: "PROJECT-A", ticketId: ticket.id }), { code: "PLAN_OWNER_DECISIONS_REQUIRED" });
});

test("new Sprint drafts return unresolved policy authority to Architecture instead of creating questionnaires", () => {
  const review = { outcome: "Restore", in_scope: "Coding", out_of_scope: "Backend", approach: "Registry", components: ["Coding"], risks: [], assumptions: [], open_questions: [], evidence_refs: ["PLAN-A"], acceptance_criteria: ["Restore"], decision_requests: [request] };
  assert.throws(() => sprintPlanDraftContent({ objective: "Restore", tickets: [ticket], human_plan: review }), { code: "ARCHITECTURE_REPLAN_REQUIRED" });
  delete review.decision_requests;
  assert.throws(() => sprintPlanDraftContent({ objective: "Restore", tickets: [ticket], human_plan: review }), { code: "ARCHITECTURE_REPLAN_REQUIRED" });
});

test("Sprint schema accepts concrete SL proposals and rejects unstructured decisions", () => {
  const require = createRequire(import.meta.url);
  const schema = require("../../../schemas/governance/sprint-plan.schema.json");
  const validate = new Ajv2020().compile(schema.properties.human_plan);
  const review = { outcome: "Restore", in_scope: "Coding", out_of_scope: "Backend", approach: "Registry", components: ["Coding"], risks: [], assumptions: [], open_questions: [], evidence_refs: ["PLAN-A"], acceptance_criteria: ["Restore"], decision_requests: [request] };
  assert.equal(validate(review), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...review, decision_requests: ["Owner will decide later"] }), false);
  assert.equal(validate({ ...review, decision_requests: [{ ...request, options: [{ id: "LOCAL" }] }] }), false);
});

test("HTTP uses authenticated owner and forwards choices only to the reviewed Sprint revision", async () => {
  let recorded;
  const result = await routePlan({ method: "POST", parts: ["plans", "PLAN-A", "1", "decisions"], projectId: "PROJECT-A", expectedProjectId: "PROJECT-A", headers: { authorization: "Bearer owner" }, body: { sha256: "a".repeat(64), decision: "approved", selections: { STORAGE: "LOCAL" }, approver_id: "FORGED" }, planOwnerAuth: { verify: () => "AUTHENTICATED-OWNER" }, planStore: { decide: async (input) => { recorded = input; return input; } } });
  assert.equal(result.status, 201);
  assert.equal(recorded.approverId, "AUTHENTICATED-OWNER");
  assert.deepEqual(recorded.selections, { STORAGE: "LOCAL" });
  assert.equal(recorded.revision, 1);
});
