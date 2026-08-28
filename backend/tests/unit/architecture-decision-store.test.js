import assert from "node:assert/strict";
import test from "node:test";

import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";

test("stores valid Architecture Decisions append-only in insertion order", () => {
  const store = createArchitectureDecisionStore();
  const first = decision("DECISION-113-1", "architecture");
  const second = decision("DECISION-113-2", "standard");
  store.append(first);
  store.append(second);
  first.title = "mutated by caller";

  assert.deepEqual(store.getAll().map(({ id }) => id), ["DECISION-113-1", "DECISION-113-2"]);
  assert.equal(store.getById("DECISION-113-1").title, "Decision DECISION-113-1");
  assert.deepEqual(store.getByType("architecture").map(({ id }) => id), ["DECISION-113-1"]);
  assert.throws(() => store.append(second), /already exists/);
});

test("rejects Architecture Decisions that violate the governance contract", () => {
  const store = createArchitectureDecisionStore();
  const invalid = decision("DECISION-113-invalid", "architecture");
  delete invalid.type;
  assert.throws(() => store.append(invalid), /Invalid Architecture Decision/);
  assert.equal(store.getAll().length, 0);
});

test("uses the same append-only store for immutable Project Owner governance decisions", () => {
  const store = createArchitectureDecisionStore();
  const approve = humanDecision("HUMAN-DECISION-139-APPROVE", "APPROVE");
  const reject = humanDecision("HUMAN-DECISION-139-REJECT", "REJECT", "The proposal needs an explicit rollback plan.");
  const changeRequest = humanDecision("HUMAN-DECISION-139-CHANGE", "CHANGE_REQUEST", "Clarify the migration boundary.");
  store.append(approve);
  store.append(reject);
  store.append(changeRequest);
  approve.actor = "mutated";

  assert.deepEqual(store.getByType("human_governance").map(({ decision_id }) => decision_id), [approve.decision_id, reject.decision_id, changeRequest.decision_id]);
  assert.equal(store.getById(reject.decision_id).reason, reject.reason);
  assert.equal(store.getById(approve.decision_id).actor, "OWNER-139");
  assert.throws(() => store.append(reject), /already exists/);
});

test("rejects invalid human governance decisions before persistence", () => {
  const store = createArchitectureDecisionStore();
  const invalidCases = [
    (() => { const value = humanDecision("HUMAN-DECISION-139-NO-ROLE", "APPROVE"); delete value.actor_role; return value; })(),
    { ...humanDecision("HUMAN-DECISION-139-WRONG-ROLE", "APPROVE"), actor_role: "builder" },
    (() => { const value = humanDecision("HUMAN-DECISION-139-NO-PROPOSAL", "APPROVE"); delete value.proposal_id; return value; })(),
    { ...humanDecision("HUMAN-DECISION-139-BAD-DECISION", "APPROVE"), decision: "MAYBE" },
    humanDecision("HUMAN-DECISION-139-NO-REASON", "REJECT"),
    (() => { const value = humanDecision("HUMAN-DECISION-139-NO-CORRELATION", "APPROVE"); delete value.correlation_id; return value; })()
  ];
  for (const invalid of invalidCases) assert.throws(() => store.append(invalid), /Invalid Architecture Decision/);
  assert.equal(store.getAll().length, 0);
});

function decision(id, type) {
  return {
    id,
    project_id: "PROJECT-113",
    type,
    title: `Decision ${id}`,
    decision: "Use Node as the governance source of truth.",
    status: "accepted",
    created_at: "2026-08-20T07:00:00Z"
  };
}

function humanDecision(decisionId, outcome, reason) {
  return {
    decision_id: decisionId,
    project_id: "PROJECT-139",
    type: "human_governance",
    actor: "OWNER-139",
    actor_role: "project_owner",
    proposal_id: "PROPOSAL-139-1",
    decision: outcome,
    ...(reason ? { reason } : {}),
    correlation_id: "CORR-139-1",
    timestamp: "2026-08-21T10:00:00Z"
  };
}
