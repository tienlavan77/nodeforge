// Keeps schema lookup, strict provider output and live dependency validation aligned for every future Sprint.
import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { createRequire } from "node:module";
import { agentDecisionSchema } from "../../src/modules/governance/agent-decision-schema.js";
import { createAgentExchangeOutput } from "../../src/modules/governance/agent-exchange-output.js";
import { validateDependencyRequest } from "../../src/modules/supervisor/dependency-repair-contract.js";
import { blockerExchangeResponse } from "../../src/modules/supervisor/blocker-agent-exchange.js";
import { createAgentExchange } from "../../src/modules/governance/agent-exchange.js";

const require = createRequire(import.meta.url);
const source = require("../../../schemas/governance/agent-exchange-decision.schema.json");

// Supplies a concrete upstream execution request without claiming a repair has already happened.
function decision() {
  return { action: "dependency_requested", summary: "Repair the approved upstream dependency.", authority_scope: "sprint",
    authority_reference: { passage_id: "SPRINT-1", rationale: "The dependency is already in the approved Sprint." }, guidance: "Keep this checkpoint and dispatch UP.",
    dependency_request: { ticket_id: "UP", reason: "The parent needs accepted upstream behavior.", instructions: "Implement only the missing behavior under the settled design.",
      expected_results: ["A new verified and reviewed repair."], evidence_refs: ["failure-receipt.json"] } };
}

// Fills nullable SDK slots while selecting the explicit action branch the provider is asked to generate.
function slots(value, schema) {
  if (schema.anyOf) {
    if (value === undefined && schema.anyOf.some((entry) => entry.type === "null")) return null;
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    return slots(value, schema.anyOf.find((entry) => (entry.type === type || entry.type?.includes?.(type))
      && (!entry.properties?.action?.enum || entry.properties.action.enum.includes(value?.action))) ?? schema.anyOf[0]);
  }
  if (schema.type === "object") return Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, slots(value?.[key], child)]));
  if (schema.type === "array") return (value ?? []).map((entry) => slots(entry, schema.items));
  return value;
}

test("SL lookup and native provider schema accept the same five fields; AM cannot dispatch dependencies", () => {
  const sl = new Ajv2020({ strict: false }).compile(agentDecisionSchema("sprint_leader"));
  const am = new Ajv2020({ strict: false }).compile(agentDecisionSchema("architecture_manager"));
  const shared = new Ajv2020({ strict: false }).compile(source);
  const value = decision();
  assert.equal(sl(value), true, JSON.stringify(sl.errors)); assert.equal(shared(value), true);
  assert.equal(am(value), false);
  validateDependencyRequest(value, { stage: "sprint_leader", request: { task_id: "PARENT" } });
  assert.throws(() => validateDependencyRequest(value, { stage: "architecture_manager" }), { code: "BLOCKER_DISPOSITION_INVALID" });
  for (const field of Object.keys(value.dependency_request)) {
    const missing = structuredClone(value); delete missing.dependency_request[field];
    assert.equal(sl(missing), false, field);
    assert.throws(() => validateDependencyRequest(missing, { stage: "sprint_leader" }));
  }
  for (const patch of [{ ticket_id: "../escape" }, { expected_results: [] }, { evidence_refs: [] }, { extra: true }, { instructions: "x".repeat(8001) }]) {
    const invalid = { ...value, dependency_request: { ...value.dependency_request, ...patch } };
    assert.equal(sl(invalid), false, JSON.stringify(patch).slice(0, 100));
    assert.throws(() => validateDependencyRequest(invalid, { stage: "sprint_leader" }));
  }
  const wrongAction = { ...value, action: "resolved" };
  assert.equal(sl(wrongAction), false); assert.equal(shared(wrongAction), false);
  const noRequest = { ...value }; delete noRequest.dependency_request;
  assert.equal(shared(noRequest), false);
  const output = createAgentExchangeOutput({ kind: "consultation_request", recipient: { role: "sprint_leader" } });
  const response = { kind: "consultation_response", subject: value.summary, evidence: [], payload: { outcome: "needs_evidence", answer: value.summary,
    rationale: "The approved target must implement the missing behavior.", authority_refs: [], next_steps: [value.guidance],
    missing_evidence: [{ needed: "New accepted upstream repair.", needed_for: "Parent verification." }], decision: value } };
  const native = slots(response, output.schema);
  const validNative = new Ajv2020({ strict: false }).compile(output.schema);
  assert.equal(validNative(native), true, JSON.stringify(validNative.errors));
  assert.deepEqual(output.normalize(native), response);
  native.payload.decision.authority_scope = "architecture";
  assert.equal(validNative(native), false);
});

test("shared exchange routes the explicit dependency action without inferring intent from prose", () => {
  const value = decision();
  const request = createAgentExchange({ context: { project_id: "P", ticket_id: "PARENT", execution_id: "RUN-PARENT" },
    sender: { agent_id: "CODER", role: "coder" }, recipient: { agent_id: "SL", role: "sprint_leader" }, kind: "consultation_request",
    subject: "Need upstream repair.", payload: { question: "Who repairs UP?", decision_needed: "Dispatch the approved repair.", known_decision_refs: [], impact: "Parent cannot continue." },
    continuation: { assignment_id: "BLOCKER:sprint_leader", checkpoint_ref: null } });
  const result = blockerExchangeResponse(value, request);
  assert.equal(result.response.payload.outcome, "needs_evidence");
  assert.deepEqual(result.value.dependency_request, value.dependency_request);
  assert.equal(result.value.action, "dependency_requested");
});
