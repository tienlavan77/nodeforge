import assert from "node:assert/strict";
import test from "node:test";

import { createAgentBootstrap } from "../../src/modules/agent/agent-bootstrap.js";
import { createAgentRegistry } from "../../src/modules/agent/agent-registry.js";
import { createGovernanceOrchestrator } from "../../src/modules/governance/governance-orchestrator.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createBuilderAdapter } from "../../src/agents/builder-adapter.js";
import { createReviewerAdapter } from "../../src/agents/reviewer-adapter.js";

test("dispatches Owner Request through Node to Architecture Manager and Sprint Leader", async () => {
  const busStore = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store: busStore });
  const registry = createAgentRegistry();
  const architectureManager = {
    createArchitecturePlan: (input) => ({ project_id: input.project_id, decision: input.decision })
  };
  const sprintLeader = {
    generateTickets: (input) => [{ id: "TICKET-128", project_id: input.project_id, from: input.architecture_result?.decision }]
  };
  const runtime = { startTask: () => ({ state: "RUNNING" }) };
  createAgentBootstrap({ registry, bus, architectureManager, sprintLeader, runtime, builder: createBuilderAdapter({ id: "builder-128" }), reviewer: createReviewerAdapter({ id: "reviewer-128" }) });
  const orchestrator = createGovernanceOrchestrator({ registry, bus });
  const request = { id: "MSG-OWNER-128", project_id: "PROJECT-128", correlation_id: "CORR-128", timestamp: "2026-08-20T13:00:00Z", payload: { project_id: "PROJECT-128", decision: "Use Node governance." } };

  const result = await orchestrator.orchestrate(request);
  assert.equal(result.correlation_id, "CORR-128");
  assert.equal(result.architecture.decision, "Use Node governance.");
  assert.equal(result.sprint[0].id, "TICKET-128");
  assert.deepEqual(orchestrator.getAudit().map(({ request: type, result: resultType }) => [type, resultType]), [
    ["governance.architecture.request", "governance.architecture.result"],
    ["governance.sprint.request", "governance.sprint.result"]
  ]);
  assert.deepEqual(busStore.getAll().map(({ message_type, correlation_id }) => ({ message_type, correlation_id })), [
    { message_type: "governance.architecture.request", correlation_id: "CORR-128" },
    { message_type: "governance.architecture.result", correlation_id: "CORR-128" },
    { message_type: "governance.sprint.request", correlation_id: "CORR-128" },
    { message_type: "governance.sprint.result", correlation_id: "CORR-128" }
  ]);
});

test("deduplicates concurrent and completed requests without mutating input", async () => {
  const bus = createAgentCommunicationBus({ store: createAgentCommunicationStore() });
  const registry = createAgentRegistry();
  createAgentBootstrap({ registry, bus, architectureManager: { createArchitecturePlan: (input) => input }, sprintLeader: { generateTickets: () => [] }, runtime: { startTask: () => ({ state: "RUNNING" }) }, builder: createBuilderAdapter({ id: "builder-128-dedupe" }), reviewer: createReviewerAdapter({ id: "reviewer-128-dedupe" }) });
  const orchestrator = createGovernanceOrchestrator({ registry, bus });
  const request = { id: "MSG-OWNER-128-2", project_id: "PROJECT-128", correlation_id: "CORR-128-2", timestamp: "2026-08-20T13:00:00Z", payload: { project_id: "PROJECT-128" } };
  const [first, second] = await Promise.all([orchestrator.orchestrate(request), orchestrator.orchestrate({ ...request, payload: { ...request.payload, changed: true } })]);
  assert.deepEqual(first, second);
  assert.equal(orchestrator.getAudit().length, 2);
  assert.equal(request.payload.changed, undefined);
  assert.deepEqual(await orchestrator.orchestrate(request), first);
  assert.equal(orchestrator.getAudit().length, 2);
});
