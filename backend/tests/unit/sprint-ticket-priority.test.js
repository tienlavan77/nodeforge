// Verifies priority schema guidance and bounded SL-selected repairs without silently changing approved ticket scope.
import assert from "node:assert/strict";
import test from "node:test";
import { createSprintPlanLeader } from "../../src/application/sprint-plan-leader.js";
import { invalidSprintTicketPriorities, repairSprintTicketPriorities, TICKET_PRIORITY_VALUES } from "../../src/modules/governance/sprint-ticket-priority.js";

// Supplies a frozen planning draft whose invalid priority mirrors the real rejected numeric output.
function candidate(priority = 1) {
  return { id: "SPRINT-PRIORITY", objective: "Publish API", tickets: [
    { id: "TICKET-PRIORITY-1", title: "Publish API", priority, acceptance_criteria: ["Approved API works"], verification_plan: [{ kind: "test", criterion_ids: ["AC-1"], test_path: "backend/tests/unit/sprint-ticket-priority.test.js" }] },
    { id: "TICKET-PRIORITY-2", title: "Review API", priority: "critical", dependencies: ["TICKET-PRIORITY-1"] }
  ] };
}

test("priority is optional and all schema enum values remain valid", () => {
  assert.deepEqual(TICKET_PRIORITY_VALUES, ["low", "medium", "normal", "high", "critical"]);
  for (const priority of TICKET_PRIORITY_VALUES) assert.deepEqual(invalidSprintTicketPriorities(candidate(priority)), []);
  const draft = candidate(); delete draft.tickets[0].priority;
  assert.deepEqual(invalidSprintTicketPriorities(draft), []);
});

test("numeric ranks, numeric strings, P labels, null and structures are not silently coerced", () => {
  for (const priority of [1, 2, "1", "P1", "HIGH", null, ["high"], { value: "high" }]) assert.deepEqual(invalidSprintTicketPriorities(candidate(priority)), [0]);
});

test("only invalid priorities are copied from SL; valid priorities, scope and verification remain frozen", () => {
  const draft = candidate(); const original = structuredClone(draft);
  const repaired = candidate("high");
  repaired.objective = "Changed scope"; repaired.tickets[0].acceptance_criteria = ["Weaker criterion"];
  repaired.tickets[0].verification_plan = []; repaired.tickets[1].priority = "low";
  const result = repairSprintTicketPriorities(draft, repaired);
  assert.deepEqual(draft, original);
  original.tickets[0].priority = "high";
  assert.deepEqual(result, original);
});

test("repair rejects invalid replacements and changes to Sprint or ticket identity", () => {
  assert.throws(() => repairSprintTicketPriorities(candidate(), candidate("1")), { code: "SPRINT_TICKET_PRIORITY_INVALID" });
  assert.throws(() => repairSprintTicketPriorities(candidate(), { ...candidate("high"), id: "SPRINT-OTHER" }), { code: "SPRINT_PRIORITY_REPAIR_IDENTITY" });
  const reversed = candidate("high"); reversed.tickets.reverse();
  assert.throws(() => repairSprintTicketPriorities(candidate(), reversed), { code: "SPRINT_PRIORITY_REPAIR_IDENTITY" });
  assert.throws(() => repairSprintTicketPriorities(candidate(), undefined), { code: "SPRINT_PRIORITY_REPAIR_IDENTITY" });
});

test("SDK draft repairs invalid priority once with explicit schema guidance and no default mapping", async () => {
  const requests = [];
  const leader = createSprintPlanLeader({ projectRoot: process.cwd(), logger: { error() {} }, sdkGateway: { execute: async (input) => {
    requests.push(input); return { text: `\`\`\`json\n${JSON.stringify(candidate(requests.length === 1 ? 1 : "high"))}\n\`\`\`` };
  } } });
  const result = await leader.requestPlan({ projectId: "PROJECT-PRIORITY", agentId: "LEADER", brief: "Approved API scope", correlationId: "CORR-PRIORITY" });
  assert.equal(requests.length, 2);
  assert.match(requests[0].prompt, /low\|medium\|normal\|high\|critical/);
  assert.match(requests[1].prompt, /Change ONLY invalid ticket priority fields/);
  assert.match(requests[1].prompt, /Numeric priorities have no defined mapping/);
  assert.equal(requests[1].correlationId, "CORR-PRIORITY-PRIORITY-REPAIR");
  assert.deepEqual(result, candidate("high"));
});

test("a second malformed SDK priority fails instead of retrying forever or inventing a valid priority", async () => {
  let requests = 0;
  const leader = createSprintPlanLeader({ projectRoot: process.cwd(), logger: { error() {} }, sdkGateway: { execute: async () => {
    requests++; return { text: `\`\`\`json\n${JSON.stringify(candidate(1))}\n\`\`\`` };
  } } });
  await assert.rejects(leader.requestPlan({ projectId: "PROJECT-PRIORITY", agentId: "LEADER", correlationId: "CORR-PRIORITY" }), { code: "SPRINT_TICKET_PRIORITY_INVALID" });
  assert.equal(requests, 2);
});

test("a valid priority does not trigger another SDK execution", async () => {
  let requests = 0;
  const leader = createSprintPlanLeader({ projectRoot: process.cwd(), logger: { error() {} }, sdkGateway: { execute: async () => {
    requests++; return { text: JSON.stringify(candidate("normal")) };
  } } });
  assert.deepEqual(await leader.requestPlan({ projectId: "PROJECT-PRIORITY", agentId: "LEADER" }), candidate("normal"));
  assert.equal(requests, 1);
});
