import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createTaskStore } from "../../src/modules/projects/task-store.js";
import { loadWorkflowDefinition } from "../../src/modules/workflows/state-machine-executor.js";
import { createWorkflowTransitionGate } from "../../src/modules/workflows/workflow-transition-gate.js";

const workflowPath = fileURLToPath(new URL("../../workflows/forge-sprint-delivery.workflow.json", import.meta.url));
const projectId = "PROJECT-NF-076";
const taskId = "TASK-NF-076";

test("runs one real task through Builder, failed test, fix, Reviewer changes, and approval", async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-full-workflow-"));
  let database;
  try {
    await mkdir(join(projectRoot, "src"), { recursive: true });
    database = await openIndexDatabase(projectRoot);
    const taskStore = createTaskStore({ database, projectId, createId: () => taskId });
    const task = taskStore.create({ id: taskId, type: "feature", title: "NF-076 workflow", status: "active", workflow_id: "forge-sprint-delivery", workflow_state: "PLANNED", created_at: "2026-08-19T13:00:00Z" });
    const workflow = await loadWorkflowDefinition(workflowPath);
    const gate = createWorkflowTransitionGate({ workflow, projectId, projectRoot, internalBus: new EventEmitter(), clock: () => new Date("2026-08-19T13:00:00Z") });
    const transitions = [];
    const move = async (request) => {
      const result = await gate.transition({ taskId, ...request });
      transitions.push(result);
      assert.equal(result.transitioned, true, `${request.event} must pass its Rule Gate`);
      return result;
    };

    await move({ currentState: "PLANNED", event: "builder.start", trigger: "commit.transition", context: { actor: "builder", task: { workflow_state: "PLANNED" }, roadmap: { commit: { id: "NF-076" } } } });
    await writeFile(join(projectRoot, "src/feature.js"), "export function feature() { return false; }\n");
    await move({ currentState: "IN_PROGRESS", event: "builder.handoff", trigger: "commit.handoff", context: handoffContext(1) });
    await move({ currentState: "TESTING", event: "test.fail", trigger: "test.fail", context: { actor: "node" } });
    await writeFile(join(projectRoot, "src/feature.js"), "export function feature() { return true; }\n");
    await move({ currentState: "IN_PROGRESS", event: "builder.handoff", trigger: "commit.handoff", context: handoffContext(2) });
    await move({ currentState: "TESTING", event: "test.pass", trigger: "test.pass", context: { actor: "node" } });
    await move({ currentState: "READY_FOR_REVIEW", event: "reviewer.request_changes", trigger: "review.request_changes", context: { actor: "reviewer" } });
    await move({ currentState: "REQUEST_CHANGES", event: "builder.resume", trigger: "workflow.resume", context: { actor: "builder" } });
    await writeFile(join(projectRoot, "src/feature.js"), "export function feature() { return true; }\n// reviewer feedback addressed\n");
    await move({ currentState: "IN_PROGRESS", event: "builder.handoff", trigger: "commit.handoff", context: handoffContext(3) });
    await move({ currentState: "TESTING", event: "test.pass", trigger: "test.pass", context: { actor: "node" } });
    await move({ currentState: "READY_FOR_REVIEW", event: "reviewer.approve", trigger: "review.complete", context: approvalContext() });

    assert.equal(taskStore.get(taskId).id, task.id);
    const state = JSON.parse(await readFile(join(projectRoot, ".forge/runtime/state.json"), "utf8"));
    assert.equal(state.tasks[taskId].workflow_state, "APPROVED");
    assert.equal(transitions.length, 10);
    assert.equal(transitions.filter(({ event }) => event === "test.fail").length, 1);
    assert.equal(transitions.filter(({ event }) => event === "reviewer.request_changes").length, 1);
    assert.equal((await readFile(join(projectRoot, "src/feature.js"), "utf8")).includes("reviewer feedback addressed"), true);
    assert.equal((await readFile(join(projectRoot, "review.md"), "utf8").catch(() => null)), null);
  } finally {
    await database?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }

  function handoffContext(attempt) {
    return {
      roadmap: { commit: { id: "NF-076" } },
      task: { id: taskId },
      builder_evidence: [{ id: `EVIDENCE-NF-076-${attempt}`, project_id: projectId, task_id: taskId, session_id: "SESSION-NF-076", builder_id: "AGENT-BUILDER-NF-076", evidence_type: "implementation_summary", payload: { summary: `Builder implementation attempt ${attempt}.` }, created_at: "2026-08-19T13:00:00Z" }]
    };
  }

  function approvalContext() {
    return {
      actor: "reviewer",
      review_result: { status: "approved", findings: [] },
      verification_result: { ready_for_review: true },
      verification_run: { level: "full", status: "passed", checks: [{ status: "passed", command: "npm test", result_ref: "RESULT-NF-076" }] },
      results: { "RESULT-NF-076": { status: "passed" } }
    };
  }
});
