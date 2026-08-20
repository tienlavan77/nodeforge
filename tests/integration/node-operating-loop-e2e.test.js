import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBuilderAdapter } from "../../src/agents/builder-adapter.js";
import { createReviewerAdapter } from "../../src/agents/reviewer-adapter.js";
import { createOwnerRequestService } from "../../src/application/owner-request-service.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentBootstrap } from "../../src/modules/agent/agent-bootstrap.js";
import { createAgentResultRouter } from "../../src/modules/agent/agent-result-router.js";
import { createAgentSessionStore } from "../../src/modules/agent/session-store.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";
import { createArchitectureKnowledgeModel } from "../../src/modules/governance/architecture-knowledge-model.js";
import { createArchitectureManager } from "../../src/modules/governance/architecture-manager.js";
import { createGovernanceOrchestrator } from "../../src/modules/governance/governance-orchestrator.js";
import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createSprintLeaderPlanner } from "../../src/modules/governance/sprint-leader-planner.js";
import { createSprintPlanProjection } from "../../src/modules/governance/sprint-plan-projection.js";
import { createTicketProvenanceTracker } from "../../src/modules/governance/ticket-provenance-tracker.js";
import { createGovernanceDependencyGraph } from "../../src/modules/governance/governance-dependency-graph.js";
import { createPersistentEventStore } from "../../src/modules/events/persistent-event-store.js";
import { createEventPublisher } from "../../src/modules/events/event-publisher.js";
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { createHistoryStore } from "../../src/modules/history/history-store.js";
import { createTaskSummaryStore } from "../../src/modules/history/task-summary-store.js";
import { createProjectMemoryStore } from "../../src/modules/history/project-memory-store.js";
import { createRuntimeService } from "../../src/application/runtime-service.js";
import { createRuntimeRecovery } from "../../src/modules/recovery/runtime-recovery.js";
import { createEventReplayEngine } from "../../src/modules/recovery/event-replay-engine.js";
import { createIdempotentRecovery } from "../../src/modules/recovery/idempotent-recovery.js";

test("runs the full Node Operating Loop through restart and replay", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-operating-loop-"));
  let database = await openIndexDatabase(root);
  try {
    const communicationStore = createAgentCommunicationStore();
    const bus = createAgentCommunicationBus({ store: communicationStore });
    const decisions = createArchitectureDecisionStore();
    const roadmaps = createRoadmapStore();
    const manager = createArchitectureManager({ decisions, knowledge: createArchitectureKnowledgeModel({ decisions }), roadmaps, bus });
    const planner = createSprintLeaderPlanner({ projection: createSprintPlanProjection({ roadmaps }), graph: createGovernanceDependencyGraph(), provenance: createTicketProvenanceTracker({ roadmaps, decisions }), bus });
    const eventStore = createPersistentEventStore({ database });
    const subscriptions = createSubscriptionRegistry();
    const publisher = createEventPublisher({ store: eventStore, subscriptions });
    const history = createHistoryStore({ subscriptions });
    const summaries = createTaskSummaryStore({ history });
    const memory = createProjectMemoryStore({ summaries });
    const sessionStore = createAgentSessionStore({ database });
    const runtime = createRuntimeService({ sessionStore, eventStore, memoryRetriever: { retrieve: () => ({ relevant_facts: [] }) }, createSessionId: () => "SESSION-134" });
    const builder = createBuilderAdapter({ id: "builder-134", perform: async () => ({ commit_id: "COMMIT-134", changed_files: ["src/governance.js"], status: "completed" }) });
    const reviewer = createReviewerAdapter({ id: "reviewer-134", perform: async () => ({ status: "approved", result: "approved" }) });
    const architectureRuntimeManager = {
      createArchitecturePlan(input) {
        const plan = manager.createArchitecturePlan(input);
        manager.createRoadmap({ ...input, architecture_decision_ids: plan.decisions.map(({ id }) => id) });
        return plan;
      },
      createRoadmap: manager.createRoadmap,
      createSprintBreakdown: manager.createSprintBreakdown
    };
    const bootstrap = createAgentBootstrap({ registry: undefined, bus, architectureManager: architectureRuntimeManager, sprintLeader: planner, runtime, builder, reviewer });
    const orchestrator = createGovernanceOrchestrator({ registry: bootstrap.registry, bus });
    const ownerRequests = createOwnerRequestService({ governanceOrchestrator: orchestrator });
    const request = { request_id: "REQ-134", correlation_id: "CORR-134", timestamp: "2026-08-20T18:00:00Z", payload: {
      project_id: "PROJECT-134", decisions: [{ id: "DECISION-134", type: "architecture", title: "Node loop", decision: "Node controls the operating loop.", status: "accepted" }],
      sprints: [{ id: "SPRINT-134", objective: "Run the loop", exit_criteria: ["Builder and Reviewer complete"], tickets: [{ id: "TICKET-134", title: "Loop ticket", objective: "Run Builder and Reviewer.", priority: "high", acceptance_criteria: ["Commit is returned"], provenance: { source: "sprint_plan", source_id: "SPRINT-134", created_at: "2026-08-20T18:00:00Z" } }] }]
    } };
    ownerRequests.submit(request);
    const governance = await orchestrator.orchestrate({ id: request.request_id, project_id: "PROJECT-134", correlation_id: request.correlation_id, timestamp: request.timestamp, payload: request.payload });
    const ticket = governance.sprint[0];
    assert.equal(ownerRequests.getById("REQ-134").status, "completed");
    assert.equal(ticket.id, "TICKET-134");

    const nodeMessages = [];
    bus.subscribe("NODE", (message) => nodeMessages.push(message));
    const router = createAgentResultRouter({ bus });
    const routed = [];
    router.registerWorkflow("CORR-TICKET-134", { "ticket.completed": (message) => routed.push(message.payload) , "review.completed": (message) => routed.push(message.payload) });
    runtime.startTask({ projectId: ticket.project_id, taskId: ticket.id });
    const builderDone = new Promise((resolve) => bus.subscribe("builder-134", async () => {
      const result = await builder.execute({ task: { ...ticket, type: "feature" } });
      bus.send({ id: "MSG-BUILDER-134-DONE", project_id: ticket.project_id, sender: { id: "builder-134", role: "builder" }, recipient: { id: "NODE", role: "node" }, message_type: "ticket.completed", correlation_id: "CORR-TICKET-134", payload: { ticket_id: ticket.id, commit_id: result.commit_id, changed_files: result.changed_files, status: result.status }, timestamp: request.timestamp });
      resolve(result);
    }));
    bus.send({ id: "MSG-NODE-134-BUILDER", project_id: ticket.project_id, sender: { id: "NODE", role: "node" }, recipient: { id: "builder-134", role: "builder" }, message_type: "ticket.assigned", correlation_id: "CORR-TICKET-134", payload: { ticket }, timestamp: request.timestamp });
    const build = await builderDone;
    const reviewDone = new Promise((resolve) => bus.subscribe("reviewer-134", async () => {
      const result = await reviewer.execute({ task: { ...ticket, type: "review" }, build });
      bus.send({ id: "MSG-REVIEWER-134-DONE", project_id: ticket.project_id, sender: { id: "reviewer-134", role: "reviewer" }, recipient: { id: "NODE", role: "node" }, message_type: "review.completed", correlation_id: "CORR-TICKET-134", payload: { ticket_id: ticket.id, status: result.status }, timestamp: request.timestamp });
      resolve(result);
    }));
    bus.send({ id: "MSG-NODE-134-REVIEWER", project_id: ticket.project_id, sender: { id: "NODE", role: "node" }, recipient: { id: "reviewer-134", role: "reviewer" }, message_type: "review.assigned", correlation_id: "CORR-TICKET-134", payload: { ticket, build }, timestamp: request.timestamp });
    const review = await reviewDone;
    publisher.publish(event("EVT-134-START", "agent.started", ticket, { state: "RUNNING" }, request.timestamp));
    publisher.publish(event("EVT-134-DONE", "agent.completed", ticket, { result: "completed", state: "COMPLETED", long_term_fact: "Architecture decision: Node operating loop completed with committed Builder output." }, "2026-08-20T18:00:01Z"));
    const summary = summaries.build(ticket.id);
    const projectMemory = memory.build(ticket.project_id);

    assert.equal(build.commit_id, "COMMIT-134");
    assert.equal(review.status, "approved");
    assert.deepEqual(routed.map(({ status }) => status), ["completed", "approved"]);
    assert.equal(nodeMessages.length, 2);
    assert.ok(communicationStore.getAll().every(({ sender, recipient }) => sender.role === "node" || recipient.role === "node"));
    assert.equal(summary.facts[0], "Architecture decision: Node operating loop completed with committed Builder output.");
    assert.equal(projectMemory.facts[0], "Architecture decision: Node operating loop completed with committed Builder output.");
    await database.close();

    database = await openIndexDatabase(root);
    const restartedEvents = createPersistentEventStore({ database });
    const restartedSessions = createAgentSessionStore({ database });
    const replayed = createEventReplayEngine().replay(restartedEvents.getAll());
    const recovered = createRuntimeRecovery({ sessionStore: restartedSessions }).recover();
    const idempotent = createIdempotentRecovery();
    assert.equal(restartedSessions.load("SESSION-134").state, "RUNNING");
    assert.equal(recovered.recoveredSessions[0].id, "SESSION-134");
    assert.equal(replayed.state.tasks[ticket.id].status, "completed");
    assert.equal(idempotent.shouldExecute({ session: recovered.recoveredSessions[0], stepId: "builder", state: replayed.state }), false);
    assert.equal(idempotent.shouldComplete({ session: recovered.recoveredSessions[0], state: replayed.state }), false);
    assert.equal(restartedEvents.getAll().length, 2);
  } finally {
    await database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function event(eventId, type, ticket, payload, timestamp) {
  return { event_id: eventId, type, project_id: ticket.project_id, task_id: ticket.id, session_id: "SESSION-134", agent_id: "runtime", timestamp, payload, metadata: { source: "node", session_id: "SESSION-134", agent_id: "runtime", task_id: ticket.id, project_id: ticket.project_id } };
}
