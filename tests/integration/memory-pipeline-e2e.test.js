import assert from "node:assert/strict";
import test from "node:test";

import { createEventPublisher } from "../../src/modules/events/event-publisher.js";
import { createEventStore } from "../../src/modules/events/event-store.js";
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { createHistoryStore } from "../../src/modules/history/history-store.js";
import { createMemoryRetriever } from "../../src/modules/history/memory-retriever.js";
import { createProjectMemoryStore } from "../../src/modules/history/project-memory-store.js";
import { createTaskSummaryStore } from "../../src/modules/history/task-summary-store.js";

test("compresses an Event stream into focused Agent context without replaying project history", () => {
  const projectId = "PROJECT-086";
  const taskId = "TASK-086";
  const subscriptions = createSubscriptionRegistry();
  const eventStore = createEventStore();
  const history = createHistoryStore({ subscriptions });
  const publisher = createEventPublisher({ store: eventStore, subscriptions, source: "workflow-engine" });

  publisher.publish(event(0, "workflow.started", projectId, taskId, { status: "started" }));
  for (let index = 1; index <= 90; index += 1) publisher.publish(event(index, "watcher.file_modified", projectId, taskId, { status: "recorded" }));
  publisher.publish(event(91, "verification.test_completed", projectId, taskId, { result: "failed" }));
  publisher.publish(event(92, "watcher.file_modified", projectId, taskId, { status: "recorded" }));
  publisher.publish(event(93, "verification.test_completed", projectId, taskId, { result: "passed" }));
  publisher.publish(event(94, "workflow.state_transitioned", projectId, taskId, { long_term_fact: "Auth migrated to v2." }));
  publisher.publish(event(95, "workflow.state_transitioned", projectId, taskId, { long_term_fact: "Architecture: Workflow uses Rule Engine." }));
  publisher.publish(event(96, "review.completed", projectId, taskId, { outcome: "approved" }));
  publisher.publish(event(97, "workflow.completed", projectId, taskId, { outcome: "approved" }));
  publisher.publish(event(98, "agents.message_received", projectId, taskId, { status: "recorded" }));
  publisher.publish(event(99, "history.summary_created", projectId, taskId, { status: "recorded" }));

  const summaries = createTaskSummaryStore({ history });
  const summary = summaries.build(taskId);
  const memories = createProjectMemoryStore({ summaries });
  const memory = memories.build(projectId);
  const retriever = createMemoryRetriever({ memory: memories });
  const agentContext = retriever.retrieve({ projectId, taskId: "TASK-086-next", query: "auth" });

  const kpi = {
    history_records_count: history.getByProject(projectId).length,
    summary_facts_count: summary.facts.length,
    memory_facts_count: memory.facts.length,
    retrieved_facts_count: agentContext.relevant_facts.length
  };
  assert.deepEqual(kpi, { history_records_count: 100, summary_facts_count: 9, memory_facts_count: 2, retrieved_facts_count: 1 });
  assert.equal(kpi.summary_facts_count < kpi.history_records_count, true);
  assert.equal(kpi.memory_facts_count < kpi.summary_facts_count, true);
  assert.deepEqual(agentContext.relevant_facts, ["Auth migrated to v2."]);
  assert.equal(agentContext.relevant_facts.some((fact) => /workflow|test|review/i.test(fact)), false);
});

function event(index, type, projectId, taskId, payload) {
  return {
    event_id: `EVT-086-${index}`,
    type,
    project_id: projectId,
    task_id: taskId,
    timestamp: "2026-08-19T19:00:00Z",
    payload
  };
}
