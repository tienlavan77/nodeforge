import assert from "node:assert/strict";
import test from "node:test";

import { createAgentContextService } from "../../src/modules/agent/context-service.js";

test("builds AgentContext from retrieval, task summary, and current task", () => {
  const calls = [];
  const service = createAgentContextService({
    memoryRetriever: {
      retrieve(input) {
        calls.push(["retrieve", input]);
        return { relevant_facts: ["Auth migrated to v2."] };
      }
    },
    taskSummaries: {
      getByTask(taskId) {
        calls.push(["summary", taskId]);
        return { task_id: taskId, facts: ["Tests passed."] };
      }
    },
    taskStore: {
      get(taskId) {
        calls.push(["task", taskId]);
        return { id: taskId, title: "Auth migration", workflow_state: "IN_PROGRESS" };
      }
    }
  });

  assert.deepEqual(service.buildContext({ projectId: "PROJECT-087", taskId: "TASK-087", query: "auth", domain: "security" }), {
    projectFacts: ["Auth migrated to v2."],
    taskFacts: ["Tests passed."],
    currentTask: { id: "TASK-087", title: "Auth migration", workflow_state: "IN_PROGRESS" }
  });
  assert.deepEqual(calls, [
    ["retrieve", { projectId: "PROJECT-087", taskId: "TASK-087", query: "auth", domain: "security" }],
    ["summary", "TASK-087"],
    ["task", "TASK-087"]
  ]);
});

test("builds a summary when it has not been materialized yet", () => {
  const service = createAgentContextService({
    memoryRetriever: { retrieve: () => ({ relevant_facts: [] }) },
    taskSummaries: { getByTask: () => undefined, build: () => ({ facts: ["Builder started work."] }) },
    taskStore: { get: () => undefined }
  });

  assert.deepEqual(service.buildContext({ projectId: "PROJECT-087", taskId: "TASK-087" }), {
    projectFacts: [],
    taskFacts: ["Builder started work."],
    currentTask: {}
  });
});

test("rejects missing context identity", () => {
  const service = createAgentContextService({
    memoryRetriever: { retrieve: () => ({ relevant_facts: [] }) },
    taskSummaries: { getByTask: () => undefined },
    taskStore: { get: () => undefined }
  });
  assert.throws(() => service.buildContext({ projectId: "PROJECT-087" }), /project_id and task_id/);
});
