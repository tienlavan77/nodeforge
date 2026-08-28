import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";
import { createArchitectureKnowledgeModel } from "../../src/modules/governance/architecture-knowledge-model.js";
import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createSprintPlanProjection } from "../../src/modules/governance/sprint-plan-projection.js";

test("reloads Architecture and Human Governance Decisions with deterministic views after restart", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-governance-144-"));
  let database = await openIndexDatabase(root);
  try {
    const first = createArchitectureDecisionStore({ database });
    first.append(architectureDecision());
    first.append(humanDecision());
    await database.close();
    database = await openIndexDatabase(root);
    const restarted = createArchitectureDecisionStore({ database });
    const knowledge = createArchitectureKnowledgeModel({ decisions: restarted });

    assert.deepEqual(restarted.getAll().map((item) => item.id ?? item.decision_id), ["DECISION-144", "HUMAN-DECISION-144"]);
    assert.equal(restarted.getById("DECISION-144").title, "Persistent architecture");
    assert.equal(restarted.getById("HUMAN-DECISION-144").decision, "APPROVE");
    assert.deepEqual(restarted.getByType("human_governance").map(({ decision_id }) => decision_id), ["HUMAN-DECISION-144"]);
    assert.deepEqual(knowledge.getArchitecture().map(({ id }) => id), ["DECISION-144"]);
    const read = restarted.getById("DECISION-144");
    read.title = "mutated";
    assert.equal(restarted.getById("DECISION-144").title, "Persistent architecture");
    assert.throws(() => restarted.append(architectureDecision()), /already exists/);
  } finally {
    await database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("reloads canonical roadmap versions and current Sprint projection after restart", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-roadmap-144-"));
  let database = await openIndexDatabase(root);
  try {
    const first = createRoadmapStore({ database });
    first.save(roadmap("1.0.0", "SPRINT-144-A"));
    first.save(roadmap("2.0.0", "SPRINT-144-B"));
    await database.close();
    database = await openIndexDatabase(root);
    const restarted = createRoadmapStore({ database });
    const projection = createSprintPlanProjection({ roadmaps: restarted });

    assert.deepEqual(restarted.getAllVersions().map(({ version }) => version), ["1.0.0", "2.0.0"]);
    assert.equal(restarted.getCurrent().version, "2.0.0");
    assert.equal(restarted.getVersion("1.0.0").sprints[0].id, "SPRINT-144-A");
    assert.equal(projection.getCurrentSprint().id, "SPRINT-144-B");
    assert.throws(() => restarted.save(roadmap("2.0.0", "SPRINT-144-C")), /already exists/);
  } finally {
    await database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function architectureDecision() {
  return { id: "DECISION-144", project_id: "PROJECT-144", type: "architecture", title: "Persistent architecture", decision: "Persist governance state.", status: "accepted", created_at: "2026-08-21T14:00:00Z" };
}

function humanDecision() {
  return { decision_id: "HUMAN-DECISION-144", project_id: "PROJECT-144", type: "human_governance", actor: "OWNER-144", actor_role: "project_owner", proposal_id: "PROPOSAL-144", decision: "APPROVE", correlation_id: "CORR-144", timestamp: "2026-08-21T14:01:00Z" };
}

function roadmap(version, sprintId) {
  return { id: `ROADMAP-144-${version}`, project_id: "PROJECT-144", version, architecture_decision_ids: ["DECISION-144"], created_at: "2026-08-21T14:00:00Z", sprints: [{ id: sprintId, roadmap_id: `ROADMAP-144-${version}`, project_id: "PROJECT-144", objective: "Persist roadmap", exit_criteria: ["Reload works"], tickets: [{ id: `TICKET-${sprintId}`, project_id: "PROJECT-144", roadmap_id: `ROADMAP-144-${version}`, sprint_id: sprintId, title: "Reload", objective: "Reload state", acceptance_criteria: ["Pass"], provenance: { source: "sprint_plan", source_id: sprintId, created_at: "2026-08-21T14:00:00Z" } }] }] };
}
