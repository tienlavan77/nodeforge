import assert from "node:assert/strict";
import test from "node:test";

import { createAgentRuntime } from "../../src/modules/agent/agent-runtime.js";
import { createContextBudgetManager } from "../../src/modules/agent/context-budget-manager.js";
import { createAgentSession } from "../../src/modules/agent/session.js";
import { createEventPublisher } from "../../src/modules/events/event-publisher.js";
import { createEventStore } from "../../src/modules/events/event-store.js";
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { createHistoryStore } from "../../src/modules/history/history-store.js";
import { createMemoryRetriever } from "../../src/modules/history/memory-retriever.js";
import { createProjectMemoryStore } from "../../src/modules/history/project-memory-store.js";
import { createTaskSummaryStore } from "../../src/modules/history/task-summary-store.js";
import { createPlanningEngine } from "../../src/modules/agent/planning-engine.js";

test("runs Agent Runtime end-to-end and feeds Task A memory to Task B", async () => {
  const projectId = "PROJECT-094";
  const taskA = { id: "TASK-094-A", title: "Migrate auth to v2", metadata: { long_term_fact: "Auth migrated to v2." } };
  const tasks = new Map([[taskA.id, taskA]]);
  const subscriptions = createSubscriptionRegistry();
  const eventStore = createEventStore();
  const publisher = createEventPublisher({ store: eventStore, subscriptions });
  const history = createHistoryStore({ subscriptions });
  const summaries = createTaskSummaryStore({ history });
  const memory = createProjectMemoryStore({ summaries });
  const retrieval = createMemoryRetriever({ memory });
  const contextService = {
    buildContext({ projectId: requestedProject, taskId, query, domain }) {
      const result = retrieval.retrieve({ projectId: requestedProject, taskId, query, domain });
      const task = tasks.get(taskId) ?? {};
      return { projectFacts: result.relevant_facts, taskFacts: [], currentTask: task };
    }
  };
  const runtime = createAgentRuntime({
    contextService,
    budgetManager: createContextBudgetManager(),
    planningEngine: createPlanningEngine(),
    publisher,
    summaries,
    memory,
    createSession: createAgentSession,
    createSessionId: () => "SESSION-094-A",
    createAgentId: () => "AGENT-094-A",
    maxFacts: 2,
    clock: () => new Date("2026-08-19T22:00:00Z")
  });

  const result = await runtime.run({ projectId, taskId: taskA.id, query: "auth" });
  assert.equal(result.status, "completed");
  assert.equal(result.sessionState, "COMPLETED");
  assert.equal(result.contextFactsRetrieved, 0);
  assert.equal(result.factsAfterBudget, 0);
  assert.equal(result.planStepsGenerated, 3);
  assert.equal(result.eventsPublished, 9);
  assert.deepEqual(result.summary.facts, ["Auth migrated to v2."]);
  assert.deepEqual(result.projectMemory.facts, ["Auth migrated to v2."]);
  assert.equal(eventStore.getByType("agent.completed").length, 1);
  assert.deepEqual(retrieval.retrieve({ projectId, taskId: "TASK-094-B", query: "auth" }).relevant_facts, ["Auth migrated to v2."]);
});

test("stops runtime execution and publishes failure without memory completion", async () => {
  const task = { id: "TASK-094-fail", title: "Failing task" };
  const subscriptions = createSubscriptionRegistry();
  const store = createEventStore();
  const publisher = createEventPublisher({ store, subscriptions });
  const history = createHistoryStore({ subscriptions });
  const summaries = createTaskSummaryStore({ history });
  const memory = createProjectMemoryStore({ summaries });
  const runtime = createAgentRuntime({
    contextService: { buildContext: () => ({ projectFacts: [], taskFacts: [], currentTask: task }) },
    budgetManager: createContextBudgetManager(), planningEngine: createPlanningEngine(), publisher, summaries, memory,
    createSessionId: () => "SESSION-094-fail", createAgentId: () => "AGENT-094-fail",
    executeStep: (step) => { if (step.type === "implementation") throw new Error("failed"); }
  });
  const result = await runtime.run({ projectId: "PROJECT-094", taskId: task.id });
  assert.equal(result.status, "failed");
  assert.equal(result.sessionState, "FAILED");
  assert.equal(result.execution.completedSteps, 1);
  assert.equal(result.execution.failedStep, "TASK-094-fail:step-2");
  assert.equal(store.getByType("agent.failed").length, 1);
  assert.equal(store.getByType("agent.completed").length, 0);
});
