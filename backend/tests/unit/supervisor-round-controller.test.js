import assert from "node:assert/strict";
import test from "node:test";
import { createSupervisorRoundController } from "../../src/modules/supervisor/round-controller.js";

test("R1 carries execution_context only inside payload", async () => {
  const expectedContext = { task_id: "TASK-1", permissions: ["read"] };
  const controller = createSupervisorRoundController({
    executionContextProvider: () => expectedContext
  });

  const request = await controller.start({
    task_id: "TASK-1",
    project_id: "PROJECT-1",
    title: "Inspect task",
    objective: "Inspect task",
    acceptance_criteria: ["Return the requested context"],
    agent_id: "builder"
  });

  assert.equal(request.execution_context, undefined);
  assert.deepEqual(request.payload.execution_context, expectedContext);
});
