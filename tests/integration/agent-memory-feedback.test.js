import assert from "node:assert/strict";
import test from "node:test";

import { createAgentEventPublisher } from "../../src/modules/agent/agent-event-publisher.js";
import { createEventPublisher } from "../../src/modules/events/event-publisher.js";
import { createEventStore } from "../../src/modules/events/event-store.js";
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { createHistoryStore } from "../../src/modules/history/history-store.js";
import { createMemoryRetriever } from "../../src/modules/history/memory-retriever.js";
import { createProjectMemoryStore } from "../../src/modules/history/project-memory-store.js";
import { createTaskSummaryStore } from "../../src/modules/history/task-summary-store.js";

test("feeds an Agent completion through History, Summary, Memory, and Retrieval", () => {
  const projectId = "PROJECT-092";
  const taskId = "TASK-092-A";
  const subscriptions = createSubscriptionRegistry();
  const eventStore = createEventStore();
  const publisher = createEventPublisher({ store: eventStore, subscriptions });
  const history = createHistoryStore({ subscriptions });
  const summaries = createTaskSummaryStore({ history });
  const memory = createProjectMemoryStore({ summaries });
  const retrieval = createMemoryRetriever({ memory });
  const agentEvents = createAgentEventPublisher({
    publisher,
    projectId,
    taskId,
    sessionId: "SESSION-092-A",
    agentId: "AGENT-092-A",
    createEventId: () => "EVT-092-completed",
    clock: () => new Date("2026-08-19T21:00:00Z")
  });

  assert.equal(agentEvents.completed({
    result: "completed",
    long_term_fact: "Auth migration completed in v2."
  }).accepted, true);

  const records = history.getByTask(taskId);
  assert.equal(eventStore.getByType("agent.completed").length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].action, "agent.completed");

  const summary = summaries.build(taskId);
  assert.deepEqual(summary.facts, ["Auth migration completed in v2."]);
  const projectMemory = memory.build(projectId);
  assert.deepEqual(projectMemory.facts, ["Auth migration completed in v2."]);

  const taskBContext = retrieval.retrieve({ projectId, taskId: "TASK-092-B", query: "auth" });
  assert.deepEqual(taskBContext.relevant_facts, ["Auth migration completed in v2."]);
});
