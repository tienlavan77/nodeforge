import test from "node:test";
import assert from "node:assert/strict";

import { createSprintOrchestrationService, extractSprintPlanJson } from "../../src/application/sprint-orchestration-service.js";

const plan = {
  id: "SPRINT-NF-TEST-001",
  roadmap_id: "ROADMAP-TEST-001",
  project_id: "PROJECT-TEST-001",
  objective: "Ship the test plan",
  tickets: [{ id: "TICKET-TEST-001", project_id: "PROJECT-TEST-001", roadmap_id: "ROADMAP-TEST-001", sprint_id: "SPRINT-NF-TEST-001", title: "Test ticket", objective: "Implement the test", owner: "sprint-leader" }],
  exit_criteria: ["Tests pass"]
};

test("extracts a fenced sprint plan JSON block", () => {
  assert.deepEqual(extractSprintPlanJson(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``), plan);
});

test("sprint leader without a JSON fence publishes agent.failed", async () => {
  const published = [];
  const service = createSprintOrchestrationService({
    sprintPlans: { getSprintById: () => plan },
    agentGateway: { async *stream() { yield { text: "plain prose" }; } },
    publisher: { publish: (event) => { published.push(event); return event; } },
    agentRoles: ["sprint-leader"]
  });
  service.run({ projectId: plan.project_id, sprintId: plan.id });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(published.at(-1).type, "agent.failed");
  assert.match(published.at(-1).payload.error, /fenced block/);
  assert.equal(service.isRunning(plan.id), false);
});
