import assert from "node:assert/strict";
import test from "node:test";

import { createBuilderAdapter } from "../../src/agents/builder-adapter.js";
import { createReviewerAdapter } from "../../src/agents/reviewer-adapter.js";
import { createEventPublisher } from "../../src/modules/events/event-publisher.js";
import { createEventStore } from "../../src/modules/events/event-store.js";
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { createExternalAgentOrchestrator } from "../../src/modules/agent/external-agent-orchestrator.js";
import { createHistoryStore } from "../../src/modules/history/history-store.js";
import { createProjectMemoryStore } from "../../src/modules/history/project-memory-store.js";
import { createTaskSummaryStore } from "../../src/modules/history/task-summary-store.js";

test("runs Builder then Reviewer through contracts and updates Memory", async () => {
  const calls = [];
  const subscriptions = createSubscriptionRegistry();
  const eventStore = createEventStore();
  const publisher = createEventPublisher({ store: eventStore, subscriptions });
  const history = createHistoryStore({ subscriptions });
  const summaries = createTaskSummaryStore({ history });
  const memory = createProjectMemoryStore({ summaries });
  const builder = createBuilderAdapter({ id: "AGENT-builder-111", perform: async () => { calls.push("builder"); return { outcome: "built" }; } });
  const reviewer = createReviewerAdapter({ id: "AGENT-reviewer-111", perform: async () => { calls.push("reviewer"); return { outcome: "approved" }; } });
  const orchestrator = createExternalAgentOrchestrator({
    builder, reviewer, publisher, summaries, memory,
    createSessionId: () => "SESSION-111",
    clock: () => new Date("2026-08-20T04:00:00Z")
  });

  const result = await orchestrator.run({ projectId: "PROJECT-111", taskId: "TASK-111", task: { id: "TASK-111", type: "feature", title: "Migrate auth" }, context: { projectFacts: [] } });
  assert.deepEqual(calls, ["builder", "reviewer"]);
  assert.equal(result.status, "completed");
  assert.deepEqual(eventStore.getAll().map(({ event_type }) => event_type), ["agent.started", "agent.plan.created", "agent.completed"]);
  assert.deepEqual(result.summary.facts, ["Agent completed: Migrate auth."]);
  assert.deepEqual(result.projectMemory.facts, ["Agent completed: Migrate auth."]);
});

test("does not call Reviewer when Builder fails", async () => {
  const calls = [];
  const store = createEventStore();
  const subscriptions = createSubscriptionRegistry();
  const history = createHistoryStore({ subscriptions });
  const summaries = createTaskSummaryStore({ history });
  const memory = createProjectMemoryStore({ summaries });
  const builder = createBuilderAdapter({ perform: async () => { calls.push("builder"); return { status: "failed" }; } });
  const reviewer = createReviewerAdapter({ perform: async () => { calls.push("reviewer"); return {}; } });
  const orchestrator = createExternalAgentOrchestrator({ builder, reviewer, publisher: createEventPublisher({ store, subscriptions }), summaries, memory });
  const result = await orchestrator.run({ projectId: "PROJECT-111", taskId: "TASK-111", task: { id: "TASK-111", type: "feature", title: "Fail" } });
  assert.equal(result.status, "failed");
  assert.deepEqual(calls, ["builder"]);
});
