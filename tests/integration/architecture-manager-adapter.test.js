import assert from "node:assert/strict";
import test from "node:test";

import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";
import { createArchitectureKnowledgeModel } from "../../src/modules/governance/architecture-knowledge-model.js";
import { createArchitectureManager } from "../../src/modules/governance/architecture-manager.js";
import { createArchitectureManagerAdapter } from "../../src/modules/governance/architecture-manager-adapter.js";
import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";

test("routes architecture request through Manager and publishes completed result to Node", async () => {
  const communicationStore = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store: communicationStore });
  const decisions = createArchitectureDecisionStore();
  const roadmaps = createRoadmapStore();
  const manager = createArchitectureManager({ decisions, knowledge: createArchitectureKnowledgeModel({ decisions }), roadmaps, bus });
  const completed = [];
  bus.subscribe("NODE-130", (message) => completed.push(message));
  const adapter = createArchitectureManagerAdapter({ manager, bus, nodeId: "NODE-130" });
  const request = {
    id: "MSG-OWNER-130",
    project_id: "PROJECT-130",
    correlation_id: "CORR-130",
    timestamp: "2026-08-20T15:00:00Z",
    message_type: "architecture.request",
    sender: { id: "NODE-130", role: "node" },
    recipient: { id: "architecture-manager", role: "architecture_manager" },
    payload: {
      request_id: "REQ-130",
      project_id: "PROJECT-130",
      created_at: "2026-08-20T15:00:00Z",
      decisions: [{ id: "DECISION-130", type: "architecture", title: "Node runtime", decision: "Use Node as the source of truth.", status: "accepted" }],
      sprints: [{ id: "SPRINT-130", objective: "Architecture runtime", exit_criteria: ["Adapter works"], tickets: [{ id: "TICKET-130", title: "Adapter", objective: "Build adapter", acceptance_criteria: ["Result returns"], provenance: { source: "sprint_plan", source_id: "SPRINT-130", created_at: "2026-08-20T15:00:00Z" } }] }]
    }
  };
  const returned = bus.send(request);
  await Promise.resolve();
  request.payload.decisions[0].title = "caller mutation";

  assert.equal(returned.id, request.id);
  assert.equal(decisions.getById("DECISION-130").title, "Node runtime");
  assert.equal(roadmaps.getCurrent().id, "ROADMAP-PROJECT-130");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.request_id, "REQ-130");
  assert.equal(completed[0].correlation_id, "CORR-130");
  assert.equal(adapter.getResult("REQ-130", "CORR-130").roadmap.id, "ROADMAP-PROJECT-130");
});

test("ignores duplicate request execution and rejects invalid messages", async () => {
  const communicationStore = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store: communicationStore });
  let calls = 0;
  const manager = { createArchitecturePlan: (input) => { calls += 1; return { decisions: [{ id: "DECISION-130-2" }], input }; }, createRoadmap: (input) => ({ id: "ROADMAP-130-2", input }) };
  const adapter = createArchitectureManagerAdapter({ manager, bus });
  const request = { id: "MSG-OWNER-130-2", project_id: "PROJECT-130", correlation_id: "CORR-130-2", timestamp: "2026-08-20T15:00:00Z", message_type: "architecture.request", sender: { id: "NODE", role: "node" }, recipient: { id: "architecture-manager", role: "architecture_manager" }, payload: { request_id: "REQ-130-2", project_id: "PROJECT-130", decisions: [], sprints: [{ id: "SPRINT-130-2", tickets: [{}] }] } };
  await adapter.handle(request);
  await adapter.handle(request);
  assert.equal(calls, 1);
  await assert.rejects(() => adapter.handle({ message_type: "wrong" }), /invalid/);
});
