import assert from "node:assert/strict";
import test from "node:test";

import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";
import { createArchitectureKnowledgeModel } from "../../src/modules/governance/architecture-knowledge-model.js";
import { createArchitectureManager } from "../../src/modules/governance/architecture-manager.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";

test("creates deterministic architecture plan and publishes it through Node", () => {
  const decisions = createArchitectureDecisionStore();
  const busStore = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store: busStore });
  const manager = createArchitectureManager({ decisions, knowledge: createArchitectureKnowledgeModel({ decisions }), roadmaps: createRoadmapStore(), bus });
  const input = { project_id: "PROJECT-118", created_at: "2026-08-20T09:00:00Z", decisions: [{ type: "architecture", title: "Use Node", decision: "Node is source of truth." }] };

  const plan = manager.createArchitecturePlan(input);
  input.decisions[0].title = "mutated";
  assert.equal(plan.decisions[0].title, "Use Node");
  assert.equal(busStore.getAll()[0].recipient.id, "NODE");
  assert.equal(busStore.getAll()[0].message_type, "governance.architecture_plan.created");
  const secondDecisions = createArchitectureDecisionStore();
  const secondBusStore = createAgentCommunicationStore();
  const secondManager = createArchitectureManager({ decisions: secondDecisions, knowledge: createArchitectureKnowledgeModel({ decisions: secondDecisions }), roadmaps: createRoadmapStore(), bus: createAgentCommunicationBus({ store: secondBusStore }) });
  assert.deepEqual(secondManager.createArchitecturePlan({ ...input, decisions: [{ id: "DECISION-118-2", type: "standard", title: "Stable IDs", decision: "Use stable IDs." }] }).project_id, "PROJECT-118");
});

test("creates a valid roadmap and sprint breakdown without direct agent calls", () => {
  const decisions = createArchitectureDecisionStore();
  const busStore = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store: busStore });
  const manager = createArchitectureManager({ decisions, knowledge: createArchitectureKnowledgeModel({ decisions }), roadmaps: createRoadmapStore(), bus });
  const input = {
    project_id: "PROJECT-118B",
    created_at: "2026-08-20T09:00:00Z",
    sprints: [{ objective: "Governance foundation", tickets: [{ title: "Store decisions", objective: "Persist decisions", acceptance_criteria: ["Can query decisions"] }], exit_criteria: ["Tests pass"] }]
  };
  const roadmap = manager.createRoadmap(input);
  const breakdown = manager.createSprintBreakdown({ ...input, roadmap_id: roadmap.id });
  assert.equal(roadmap.sprints[0].tickets[0].provenance.source, "sprint_plan");
  assert.equal(breakdown.sprints[0].id, roadmap.sprints[0].id);
  assert.deepEqual(busStore.getAll().map(({ message_type }) => message_type), ["governance.roadmap.created", "governance.sprint_breakdown.created"]);
});
