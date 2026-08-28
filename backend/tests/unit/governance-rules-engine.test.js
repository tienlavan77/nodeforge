import assert from "node:assert/strict";
import test from "node:test";

import { createGovernanceRulesEngine } from "../../src/modules/governance/governance-rules-engine.js";

test("registers valid Governance Rules and evaluates them in stable order", () => {
  const engine = createGovernanceRulesEngine();
  const provenance = rule("GOV-120-1", { required_field: "ticket.provenance.source" });
  const owner = rule("GOV-120-2", { equals: { path: "ticket.owner", value: "owner-1" } }, "orchestrator");
  engine.registerRule(provenance);
  engine.registerRule(owner);
  provenance.name = "mutated by caller";

  const context = { ticket: { provenance: { source: "SPRINT-120" }, owner: "owner-1" } };
  const result = engine.evaluate(context);
  context.ticket.owner = "changed after evaluation";

  assert.equal(result.decision, "ALLOW");
  assert.deepEqual(result.outcomes.map(({ rule_id }) => rule_id), ["GOV-120-1", "GOV-120-2"]);
  assert.equal(engine.getRules()[0].name, "Rule GOV-120-1");
  assert.deepEqual(engine.evaluate({ ticket: { provenance: { source: "SPRINT-120" }, owner: "owner-1" } }), result);
});

test("rejects invalid Rules and denies blocking rules whose condition fails", () => {
  const engine = createGovernanceRulesEngine();
  const invalid = rule("GOV-120-invalid", { required_field: "ticket.id" });
  delete invalid.trigger;
  assert.throws(() => engine.registerRule(invalid), /Invalid Governance Rule/);

  engine.registerRule(rule("GOV-120-block", { all: [{ required_field: "ticket.id" }, { not: { equals: { path: "ticket.status", value: "cancelled" } } }] }));
  const denied = engine.evaluate({ ticket: { id: "TICKET-120", status: "cancelled" } });
  assert.equal(denied.decision, "DENY");
  assert.equal(denied.outcomes[0].passed, false);
  assert.throws(() => engine.evaluate(), /object context/);
});

function rule(id, condition, enforcement = "blocking") {
  return {
    id,
    name: `Rule ${id}`,
    trigger: "ticket.create",
    condition,
    enforcement,
    severity: "high",
    enabled: true
  };
}
