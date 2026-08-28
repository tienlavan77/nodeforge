import assert from "node:assert/strict";
import test from "node:test";

import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";
import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createSprintLeaderAdapter } from "../../src/modules/governance/sprint-leader-adapter.js";
import { createSprintLeaderPlanner } from "../../src/modules/governance/sprint-leader-planner.js";
import { createSprintPlanProjection } from "../../src/modules/governance/sprint-plan-projection.js";
import { createTicketProvenanceTracker } from "../../src/modules/governance/ticket-provenance-tracker.js";
import { createGovernanceDependencyGraph } from "../../src/modules/governance/governance-dependency-graph.js";

test("routes sprint plan request through Planner and publishes provenance-valid tickets to Node", async () => {
  const communicationStore = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store: communicationStore });
  const decisions = createArchitectureDecisionStore();
  decisions.append({ id: "DECISION-131", project_id: "PROJECT-131", type: "architecture", title: "Plan source", decision: "Roadmap is canonical.", status: "accepted", created_at: "2026-08-20T16:00:00Z" });
  const roadmaps = createRoadmapStore();
  roadmaps.save({ id: "ROADMAP-131", project_id: "PROJECT-131", version: "1.0.0", architecture_decision_ids: ["DECISION-131"], created_at: "2026-08-20T16:00:00Z", sprints: [{ id: "SPRINT-131", roadmap_id: "ROADMAP-131", project_id: "PROJECT-131", objective: "Sprint planning", exit_criteria: ["Tickets returned"], tickets: [{ id: "TICKET-131", project_id: "PROJECT-131", roadmap_id: "ROADMAP-131", sprint_id: "SPRINT-131", title: "Build ticket", objective: "Build it", acceptance_criteria: ["Done"], priority: "high", provenance: { source: "sprint_plan", source_id: "SPRINT-131", created_at: "2026-08-20T16:00:00Z" } }] }] });
  const planner = createSprintLeaderPlanner({ projection: createSprintPlanProjection({ roadmaps }), graph: createGovernanceDependencyGraph(), provenance: createTicketProvenanceTracker({ roadmaps, decisions }), bus });
  const completed = [];
  bus.subscribe("NODE-131", (message) => completed.push(message));
  const adapter = createSprintLeaderAdapter({ planner, bus, nodeId: "NODE-131" });
  const request = { id: "MSG-SPRINT-131", project_id: "PROJECT-131", correlation_id: "CORR-131", timestamp: "2026-08-20T16:00:00Z", message_type: "sprint.plan.request", sender: { id: "NODE-131", role: "node" }, recipient: { id: "sprint-leader", role: "sprint_lead" }, payload: { request_id: "REQ-131" } };
  bus.send(request);
  await Promise.resolve();
  request.payload.request_id = "mutated";

  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.request_id, "REQ-131");
  assert.equal(completed[0].correlation_id, "CORR-131");
  assert.equal(completed[0].payload.sprint.id, "SPRINT-131");
  assert.equal(completed[0].payload.tickets[0].id, "TICKET-131");
  assert.equal(planner.selectCurrentSprint().id, "SPRINT-131");
  assert.equal(adapter.getResult("REQ-131", "CORR-131").tickets[0].id, "TICKET-131");
});

test("deduplicates sprint requests and rejects invalid messages", async () => {
  const bus = createAgentCommunicationBus({ store: createAgentCommunicationStore() });
  let generated = 0;
  const planner = { selectCurrentSprint: () => ({ id: "SPRINT-131-2" }), generateTickets: () => { generated += 1; return []; }, prioritizeBacklog: (tickets) => tickets };
  const adapter = createSprintLeaderAdapter({ planner, bus });
  const request = { id: "MSG-SPRINT-131-2", project_id: "PROJECT-131", correlation_id: "CORR-131-2", timestamp: "2026-08-20T16:00:00Z", message_type: "sprint.plan.request", sender: { id: "NODE", role: "node" }, recipient: { id: "sprint-leader", role: "sprint_lead" }, payload: { request_id: "REQ-131-2" } };
  await adapter.handle(request);
  await adapter.handle(request);
  assert.equal(generated, 1);
  assert.throws(() => adapter.handle({ message_type: "wrong" }), /invalid/);
});
