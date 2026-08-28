import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryRetriever } from "../../src/modules/history/memory-retriever.js";

test("retrieves only auth facts from Project Memory without history noise", () => {
  const memory = {
    get(projectId) {
      assert.equal(projectId, "PROJECT-085");
      return {
        project_id: projectId,
        facts: [
          "Auth migrated to v2.",
          "Auth tokens require server-side validation.",
          "Architecture: Workflow uses Rule Engine.",
          "Deployment uses blue-green releases."
        ]
      };
    }
  };
  const retrieval = createMemoryRetriever({ memory });
  const result = retrieval.retrieve({ projectId: "PROJECT-085", taskId: "TASK-auth", query: "auth" });

  assert.deepEqual(result, {
    project_id: "PROJECT-085",
    task_id: "TASK-auth",
    source: "project_memory",
    relevant_facts: ["Auth migrated to v2.", "Auth tokens require server-side validation."]
  });
  assert.equal(result.relevant_facts.some((fact) => /workflow|deployment/i.test(fact)), false);
});

test("filters Project Memory by query and domain without falling back to all facts", () => {
  const retrieval = createMemoryRetriever({ memory: { get: () => ({ facts: ["Auth migrated to v2.", "Architecture: Workflow uses Rule Engine."] }) } });

  assert.deepEqual(retrieval.retrieve({ projectId: "PROJECT-085", taskId: "TASK-workflow", domain: "workflow" }).relevant_facts, ["Architecture: Workflow uses Rule Engine."]);
  assert.deepEqual(retrieval.retrieve({ projectId: "PROJECT-085", taskId: "TASK-none", query: "unrelated" }).relevant_facts, []);
});
