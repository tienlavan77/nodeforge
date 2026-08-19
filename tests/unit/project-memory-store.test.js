import assert from "node:assert/strict";
import test from "node:test";

import { createProjectMemoryStore } from "../../src/modules/history/project-memory-store.js";

test("reduces multiple Task Summaries to deduplicated long-term project facts", () => {
  const summaries = {
    getByProject(projectId) {
      assert.equal(projectId, "PROJECT-083");
      return [
        { task_id: "TASK-1", project_id: projectId, facts: ["Tests failed.", "Decision: Event identity = event_id.", "Reviewer approved."] },
        { task_id: "TASK-2", project_id: projectId, facts: ["Architecture: Workflow uses Rule Engine.", "Builder changed project files.", "Tests passed."] },
        { task_id: "TASK-3", project_id: projectId, facts: ["Auth migrated to v2.", "Ajv is the standard validator.", "Decision: Event identity = event_id."] }
      ];
    }
  };
  const memories = createProjectMemoryStore({ summaries });
  const memory = memories.build("PROJECT-083");

  assert.deepEqual(memory, {
    project_id: "PROJECT-083",
    facts: ["Decision: Event identity = event_id.", "Architecture: Workflow uses Rule Engine.", "Auth migrated to v2.", "Ajv is the standard validator."],
    source_fact_count: 9
  });
  assert.equal(memory.facts.length < memory.source_fact_count, true);
  assert.deepEqual(memories.get("PROJECT-083"), memory);
});
