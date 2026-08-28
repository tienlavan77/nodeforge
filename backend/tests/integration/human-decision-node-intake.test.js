import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHumanDecisionService } from "../../src/application/human-decision-service.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";

test("accepts APPROVE, REJECT, and CHANGE_REQUEST, persists decisions/audit, and reloads after restart", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-human-decision-"));
  let database = await openIndexDatabase(root);
  try {
    let { decisions, communications, service } = setup(database);
    decisions.append(proposal());
    const approve = service.submit(request("HUMAN-139B-APPROVE", "APPROVE"));
    const reject = service.submit(request("HUMAN-139B-REJECT", "REJECT", "Needs rollback."));
    const change = service.submit(request("HUMAN-139B-CHANGE", "CHANGE_REQUEST", "Clarify constraints."));
    assert.equal(approve.audit.correlation_id, "CORR-139B");
    assert.equal(communications.getByCorrelationId("CORR-139B").length, 3);
    assert.equal(reject.decision.reason, "Needs rollback.");
    assert.equal(change.decision.decision, "CHANGE_REQUEST");
    assert.throws(() => service.submit(request("HUMAN-139B-APPROVE", "APPROVE")), /already exists/);
    assert.equal(communications.getAll().length, 3);
    await database.close();
    database = await openIndexDatabase(root);
    ({ decisions, communications } = setup(database));
    assert.equal(decisions.getById("HUMAN-139B-APPROVE").decision, "APPROVE");
    assert.equal(communications.getById("MSG-HUMAN-DECISION-HUMAN-139B-REJECT").payload.decision, "REJECT");
  } finally { await database?.close(); await rm(root, { recursive: true, force: true }); }
});

test("rejects invalid contract, unknown proposal, and creates no audit record", () => {
  const { decisions, communications, service } = setup();
  decisions.append(proposal());
  for (const bad of [request("BAD-ROLE", "APPROVE", undefined, "builder"), request("BAD-REJECT", "REJECT"), { ...request("BAD-PROPOSAL", "APPROVE"), proposal_id: "MISSING" }, { ...request("BAD-OUTCOME", "APPROVE"), decision: "MAYBE" }, (() => { const value = request("BAD-MISSING-ROLE", "APPROVE"); delete value.actor_role; return value; })()]) {
    assert.throws(() => service.submit(bad));
  }
  assert.equal(communications.getAll().length, 0);
});

function setup(database) {
  const decisions = createArchitectureDecisionStore({ database });
  const communications = createAgentCommunicationStore({ database });
  return { decisions, communications, service: createHumanDecisionService({ decisions, bus: createAgentCommunicationBus({ store: communications }) }) };
}
function proposal() { return { id: "PROPOSAL-139B", project_id: "PROJECT-139B", type: "architecture", title: "Architecture proposal", decision: "Use Node boundary.", status: "proposed", created_at: "2026-08-21T15:00:00Z" }; }
function request(decisionId, decision, reason, actorRole = "project_owner") { return { decision_id: decisionId, project_id: "PROJECT-139B", type: "human_governance", actor: "OWNER-139B", actor_role: actorRole, proposal_id: "PROPOSAL-139B", decision, ...(reason ? { reason } : {}), correlation_id: "CORR-139B", timestamp: "2026-08-21T15:01:00Z" }; }
