import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBuilderAdapter } from "../../src/agents/builder-adapter.js";
import { createReviewerAdapter } from "../../src/agents/reviewer-adapter.js";
import { createRuntimeService } from "../../src/application/runtime-service.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";
import { createArchitectureKnowledgeModel } from "../../src/modules/governance/architecture-knowledge-model.js";
import { createArchitectureManager } from "../../src/modules/governance/architecture-manager.js";
import { createGovernanceDependencyGraph } from "../../src/modules/governance/governance-dependency-graph.js";
import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createSprintLeaderPlanner } from "../../src/modules/governance/sprint-leader-planner.js";
import { createSprintPlanProjection } from "../../src/modules/governance/sprint-plan-projection.js";
import { createTicketProvenanceTracker } from "../../src/modules/governance/ticket-provenance-tracker.js";
import { createAgentSessionStore } from "../../src/modules/agent/session-store.js";
import { createEventPublisher } from "../../src/modules/events/event-publisher.js";
import { createPersistentEventStore } from "../../src/modules/events/persistent-event-store.js";
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { createHistoryStore } from "../../src/modules/history/history-store.js";
import { createProjectMemoryStore } from "../../src/modules/history/project-memory-store.js";
import { createTaskSummaryStore } from "../../src/modules/history/task-summary-store.js";

test("governance flow is Node-mediated, auditable, provenance-valid, replayable, and recoverable", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-governance-e2e-"));
  let database = await openIndexDatabase(root);
  try {
    const decisions = createArchitectureDecisionStore();
    const roadmaps = createRoadmapStore();
    const communication = createAgentCommunicationStore();
    const bus = createAgentCommunicationBus({ store: communication });
    const receivedByNode = [];
    bus.subscribe("NODE", (message) => receivedByNode.push(message));
    const manager = createArchitectureManager({ decisions, knowledge: createArchitectureKnowledgeModel({ decisions }), roadmaps, bus });

    // The human request enters Node; subsequent actor traffic is persisted through the Bus.
    bus.send(message("MSG-121-NODE-ARCH", "NODE", "node", "ARCHITECTURE-MANAGER", "architecture_manager", "architecture.request", { vision: "Node-governed delivery" }));
    const plan = manager.createArchitecturePlan({
      project_id: "PROJECT-121", created_at: at(1), timestamp: at(1),
      decisions: [{ id: "DECISION-121", type: "architecture", title: "Node mediation", decision: "All agent communication is audited by Node.", status: "accepted" }]
    });
    const roadmap = manager.createRoadmap({
      project_id: "PROJECT-121", id: "ROADMAP-121", version: "1.0.0", created_at: at(2), timestamp: at(2), architecture_decision_ids: plan.decisions.map(({ id }) => id),
      sprints: [{ id: "SPRINT-121", objective: "Governance E2E", exit_criteria: ["Node audit is complete"], tickets: [{ id: "TICKET-121", title: "Deliver governance flow", objective: "Run the Node-governed flow.", priority: "high", acceptance_criteria: ["Reviewer approves"], provenance: { source: "sprint_plan", source_id: "SPRINT-121", created_at: at(2) } }] }]
    });
    manager.createSprintBreakdown({ project_id: "PROJECT-121", roadmap_id: roadmap.id, created_at: at(3), timestamp: at(3), sprints: roadmap.sprints });

    const tracker = createTicketProvenanceTracker({ roadmaps, decisions });
    const leader = createSprintLeaderPlanner({ projection: createSprintPlanProjection({ roadmaps }), graph: createGovernanceDependencyGraph(), provenance: tracker, bus });
    const [ticket] = leader.generateTickets();
    assert.equal(leader.selectCurrentSprint().id, "SPRINT-121");
    assert.equal(tracker.getProvenance(ticket.id).architecture_decisions[0].id, "DECISION-121");
    leader.publishTickets(leader.prioritizeBacklog([ticket]));

    const subscriptions = createSubscriptionRegistry();
    const events = createPersistentEventStore({ database });
    const publisher = createEventPublisher({ store: events, subscriptions });
    const history = createHistoryStore({ subscriptions });
    const summaries = createTaskSummaryStore({ history });
    const memory = createProjectMemoryStore({ summaries });
    const runtime = createRuntimeService({ sessionStore: createAgentSessionStore({ database }), eventStore: events, memoryRetriever: { retrieve: () => ({ relevant_facts: [] }) }, createSessionId: () => "SESSION-121" });
    runtime.startTask({ projectId: ticket.project_id, taskId: ticket.id });
    bus.send(message("MSG-121-NODE-RUNTIME", "NODE", "node", "RUNTIME-121", "runtime", "runtime.ticket.assigned", { ticket }));

    const builder = createBuilderAdapter({ id: "BUILDER-121", perform: async () => ({ outcome: "built" }) });
    bus.send(message("MSG-121-NODE-BUILDER", "NODE", "node", "BUILDER-121", "builder", "builder.ticket.assigned", { ticket }));
    const build = await builder.execute({ task: { ...ticket, type: "feature" } });
    bus.send(message("MSG-121-BUILDER-NODE", "BUILDER-121", "builder", "NODE", "node", "builder.completed", build));

    const reviewer = createReviewerAdapter({ id: "REVIEWER-121", perform: async () => ({ outcome: "approved" }) });
    bus.send(message("MSG-121-NODE-REVIEWER", "NODE", "node", "REVIEWER-121", "reviewer", "reviewer.ticket.assigned", { ticket, build }));
    const review = await reviewer.execute({ task: { ...ticket, type: "review" }, build });
    bus.send(message("MSG-121-REVIEWER-NODE", "REVIEWER-121", "reviewer", "NODE", "node", "reviewer.completed", review));
    bus.send(message("MSG-121-NODE-RUNTIME-COMPLETE", "NODE", "node", "RUNTIME-121", "runtime", "runtime.completed", { ticket_id: ticket.id, review }));
    publisher.publish(event("EVT-121-STARTED", "agent.started", ticket, { state: "RUNNING" }, at(4)));
    publisher.publish(event("EVT-121-COMPLETED", "agent.completed", ticket, { result: "completed", state: "COMPLETED", long_term_fact: "Architecture decision: Node mediation is required." }, at(5)));
    const summary = summaries.build(ticket.id);
    const projectMemory = memory.build(ticket.project_id);

    assert.equal(communication.getAll().length, 11);
    assert.equal(receivedByNode.length, 6);
    assert.ok(communication.getAll().every(({ sender, recipient }) => sender.role === "node" || recipient.role === "node"));
    assert.deepEqual(summary.facts, ["Architecture decision: Node mediation is required."]);
    assert.deepEqual(projectMemory.facts, ["Architecture decision: Node mediation is required."]);
    assert.equal(runtime.getSession("SESSION-121").state, "RUNNING");
    await database.close();

    database = await openIndexDatabase(root);
    const recoveredRuntime = createRuntimeService({ sessionStore: createAgentSessionStore({ database }), eventStore: createPersistentEventStore({ database }), memoryRetriever: { retrieve: () => ({ relevant_facts: [] }) } });
    assert.deepEqual(recoveredRuntime.getBootstrap().recovery.recoveredSessions.map(({ id, state }) => ({ id, state })), [{ id: "SESSION-121", state: "RUNNING" }]);
    assert.equal(recoveredRuntime.getBootstrap().replay.state.tasks[ticket.id].status, "completed");
    assert.equal(recoveredRuntime.getSession("SESSION-121").state, "RUNNING");
  } finally {
    await database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function message(id, senderId, senderRole, recipientId, recipientRole, messageType, payload) {
  return { id, project_id: "PROJECT-121", sender: { id: senderId, role: senderRole }, recipient: { id: recipientId, role: recipientRole }, message_type: messageType, payload, timestamp: at(1) };
}

function event(eventId, type, ticket, payload, timestamp) {
  return { event_id: eventId, type, project_id: ticket.project_id, task_id: ticket.id, session_id: "SESSION-121", agent_id: "RUNTIME-121", timestamp, payload, metadata: { source: "node", session_id: "SESSION-121", agent_id: "RUNTIME-121" } };
}

function at(second) {
  return `2026-08-20T12:00:0${second}Z`;
}
