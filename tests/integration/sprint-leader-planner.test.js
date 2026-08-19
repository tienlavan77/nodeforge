import assert from "node:assert/strict";
import test from "node:test";

import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createGovernanceDependencyGraph } from "../../src/modules/governance/governance-dependency-graph.js";
import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createSprintLeaderPlanner } from "../../src/modules/governance/sprint-leader-planner.js";
import { createSprintPlanProjection } from "../../src/modules/governance/sprint-plan-projection.js";
import { createTicketProvenanceTracker } from "../../src/modules/governance/ticket-provenance-tracker.js";

test("Sprint Leader turns the current Node Sprint into provenance-valid prioritized tickets published to Node", () => {
  const decisions = createArchitectureDecisionStore();
  decisions.append({ id: "DECISION-119", project_id: "PROJECT-119", type: "architecture", title: "Node governed planning", decision: "Tickets originate from a Roadmap.", status: "accepted", created_at: "2026-08-20T11:00:00Z" });
  const roadmaps = createRoadmapStore();
  roadmaps.save(roadmap());
  const communicationStore = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store: communicationStore });
  const received = [];
  bus.subscribe("NODE", (message) => received.push(message));
  const tracker = createTicketProvenanceTracker({ roadmaps, decisions });
  const planner = createSprintLeaderPlanner({
    projection: createSprintPlanProjection({ roadmaps }),
    graph: createGovernanceDependencyGraph(),
    provenance: tracker,
    bus
  });

  const sprint = planner.selectCurrentSprint();
  const generated = planner.generateTickets();
  const prioritized = planner.prioritizeBacklog(generated);
  const published = planner.publishTickets(prioritized);
  generated[0].title = "caller mutation";

  assert.equal(sprint.id, "SPRINT-119");
  assert.deepEqual(prioritized.map(({ id }) => id), ["TICKET-HIGH", "TICKET-NORMAL"]);
  assert.equal(tracker.getProvenance("TICKET-HIGH").roadmap.id, "ROADMAP-119");
  assert.deepEqual(published.map(({ payload }) => payload.ticket.id), ["TICKET-HIGH", "TICKET-NORMAL"]);
  assert.deepEqual(received.map(({ recipient }) => recipient.id), ["NODE", "NODE"]);
  assert.equal(communicationStore.getAll()[0].payload.ticket.title, "High priority work");
  assert.deepEqual(planner.publishTickets(prioritized), []);
});

function roadmap() {
  return {
    id: "ROADMAP-119", project_id: "PROJECT-119", version: "1.0.0", architecture_decision_ids: ["DECISION-119"], created_at: "2026-08-20T11:00:00Z",
    sprints: [{
      id: "SPRINT-119", roadmap_id: "ROADMAP-119", project_id: "PROJECT-119", objective: "Plan Node work", exit_criteria: ["Tickets published"],
      tickets: [ticket("TICKET-NORMAL", "normal", "Normal work"), ticket("TICKET-HIGH", "high", "High priority work")]
    }]
  };
}

function ticket(id, priority, title) {
  return { id, project_id: "PROJECT-119", roadmap_id: "ROADMAP-119", sprint_id: "SPRINT-119", title, objective: title, acceptance_criteria: ["Work completes"], priority, provenance: { source: "sprint_plan", source_id: "SPRINT-119", created_at: "2026-08-20T11:00:00Z" } };
}
