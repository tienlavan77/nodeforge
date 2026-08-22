import test from "node:test";
import assert from "node:assert/strict";

import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createSprintPlanUploadService } from "../../src/application/sprint-plan-upload-service.js";

const plan = {
  id: "SPRINT-UPLOAD-1",
  roadmap_id: "ROADMAP-UPLOAD-1",
  project_id: "PROJECT-UPLOAD-1",
  objective: "Upload a sprint plan",
  tickets: [{
    id: "TICKET-UPLOAD-1", project_id: "PROJECT-UPLOAD-1", roadmap_id: "ROADMAP-UPLOAD-1", sprint_id: "SPRINT-UPLOAD-1",
    title: "Validate upload", objective: "Validate upload", acceptance_criteria: ["The plan is stored"],
    priority: "high", provenance: { source: "sprint_plan", source_id: "SPRINT-UPLOAD-1", created_at: "2026-08-21T00:00:00Z" }
  }],
  exit_criteria: ["The plan is visible"]
};

test("uploads and projects a valid sprint plan into the roadmap store", () => {
  const roadmaps = createRoadmapStore();
  const service = createSprintPlanUploadService({ roadmaps });
  const result = service.upload({ projectId: plan.project_id, sprintPlan: plan });
  assert.equal(result.sprint_plan.id, plan.id);
  assert.equal(result.roadmap.sprints[0].id, plan.id);
  assert.equal(roadmaps.getCurrent().project_id, plan.project_id);
});

test("rejects malformed plans and project mismatches", () => {
  const service = createSprintPlanUploadService({ roadmaps: createRoadmapStore() });
  assert.throws(() => service.upload({ projectId: plan.project_id, sprintPlan: { ...plan, tickets: [] } }), /Invalid Sprint Plan/);
  assert.throws(() => service.upload({ projectId: "OTHER", sprintPlan: plan }), /project_id must match/);
});
