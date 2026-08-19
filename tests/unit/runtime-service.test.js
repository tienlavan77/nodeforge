import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeService } from "../../src/application/runtime-service.js";

test("starts, pauses, resumes, reads a session, and retrieves project memory", () => {
  const service = createRuntimeService({
    createSessionId: () => "SESSION-104",
    memoryRetriever: {
      retrieve(input) {
        assert.deepEqual(input, { projectId: "PROJECT-104", taskId: "TASK-104", query: "auth", domain: "security" });
        return { project_id: input.projectId, task_id: input.taskId, source: "project_memory", relevant_facts: ["Auth migrated to v2."] };
      }
    }
  });

  assert.equal(service.startTask({ projectId: "PROJECT-104", taskId: "TASK-104" }).state, "RUNNING");
  assert.equal(service.pauseSession("SESSION-104").state, "PAUSED");
  assert.equal(service.getSession("SESSION-104").state, "PAUSED");
  assert.equal(service.resumeSession("SESSION-104").state, "RUNNING");
  assert.deepEqual(service.getProjectMemory({ projectId: "PROJECT-104", taskId: "TASK-104", query: "auth", domain: "security" }).relevant_facts, ["Auth migrated to v2."]);
});

test("rejects unknown sessions and duplicate session IDs", () => {
  const service = createRuntimeService({ createSessionId: () => "SESSION-104", memoryRetriever: { retrieve: () => ({ relevant_facts: [] }) } });
  assert.throws(() => service.getSession("SESSION-missing"), /Unknown Agent Session/);
  service.startTask({ projectId: "PROJECT-104", taskId: "TASK-104" });
  assert.throws(() => service.startTask({ projectId: "PROJECT-104", taskId: "TASK-104" }), /Session already exists/);
});
