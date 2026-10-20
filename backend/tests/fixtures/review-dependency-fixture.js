// Builds real SQLite review repair state with an upstream ticket completed by a newer execution of the same plan.
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";
import { captureDependencyExpectations } from "../../src/modules/supervisor/ticket-dependency-expectations.js";
import { createReviewDependencyReconciliation } from "../../src/modules/supervisor/review-dependency-reconciliation.js";

// Retains immutable evidence and parked repair identity without running providers or touching production runtime.
export async function reviewDependencyFixture() {
  const root = await mkdtemp(join(tmpdir(), "nf-review-dependencies-"));
  const database = await createDatabaseService({ dataDir: root });
  const files = createFileService({ projectRoot: root });
  const projectId = "P";
  const store = createTicketStatusStore({ database, projectId });
  const basis = { project_id: projectId, sprint_id: "S", plan_id: "PLAN", plan_revision: 1, plan_path: ".forge/plans/1.json", plan_sha256: "a".repeat(64), version: 1, status: "ready" };
  const registry = { get: () => basis, getByTicket: async () => basis };
  const ticket = { id: "DOWN", project_id: projectId, sprint_id: "S", dependencies: ["UP"] };
  store.create("UP"); store.beginExecution("UP", { executionId: "OLD", basis, expectedVersion: 0, dependencyExpectations: [] }); store.updateStatus("UP", "done");
  const previous = await captureDependencyExpectations({ projectId, ticket, sprintRegistry: registry, ticketStatusStore: store });
  store.create("DOWN"); store.beginExecution("DOWN", { executionId: "REPAIR", basis, expectedVersion: 0, dependencyExpectations: previous }); store.updateStatus("DOWN", "done");
  store.reopenReview("DOWN", { expectedVersion: store.get("DOWN").version, executionId: "REPAIR", binding: { job_id: "REVIEW", commit: "b".repeat(40), artifact_id: "ARTIFACT-DOWN", owner_request: "Repair review findings", receipt: "review.json" } });
  store.beginExecution("UP", { executionId: "NEW", basis, expectedVersion: store.get("UP").version, fresh: true, dependencyExpectations: [] }); store.updateStatus("UP", "done");
  const dependencies = await captureDependencyExpectations({ projectId, ticket, sprintRegistry: registry, ticketStatusStore: store });
  const artifact = { task_id: "UP", project_id: projectId, artifact_id: "ARTIFACT-UP", commit_sha: "c".repeat(40), base_sha: "d".repeat(40), source_revision: "source", manifest_sha: "manifest", status: "passed" };
  const context = { task_id: "UP", project_id: projectId, state: "terminal", review_commit_sha: artifact.commit_sha, verification_artifact_id: artifact.artifact_id, base_sha: artifact.base_sha, source_revision: artifact.source_revision, manifest_sha: artifact.manifest_sha };
  const downstream = { task_id: "DOWN", project_id: projectId, state: "terminal", review_commit_sha: "b".repeat(40), verification_artifact_id: "ARTIFACT-DOWN" };
  await files.atomicWrite({ path: ".forge/runtime/ticket-integrations/UP.json", content: JSON.stringify({ task_id: "UP", status: "completed", commit: artifact.commit_sha, artifact_id: artifact.artifact_id, manifest_sha: artifact.manifest_sha, source_revision: artifact.source_revision }), replace: false });
  const artifactPath = ".forge/runtime/ticket-verification/UP/artifacts/ARTIFACT-UP.json";
  await files.atomicWrite({ path: artifactPath, content: JSON.stringify(artifact), replace: false });
  const workspace = { fileService: files, executionContexts: { load: async (id) => id === "UP" ? context : downstream } };
  const logs = [];
  const options = { ticketStatusStore: store, sprintRegistry: registry, resolveTicketWorkspace: async () => workspace, fileService: files, projectLogger: (event) => logs.push(event) };
  const reconcile = createReviewDependencyReconciliation(options);
  const input = { projectId, ticket, current: store.get("DOWN"), checkpoint: { status: "completed", last_completed_turn: 127 }, dependencyExpectations: dependencies,
    reviewCheckpoint: { status: "completed", verdict: "request_changes", commit: downstream.review_commit_sha, verification: { artifact_id: downstream.verification_artifact_id } } };
  return { root, database, files, store, basis, registry, ticket, previous, dependencies, artifact, artifactPath, context, downstream, logs, options, reconcile, input,
    close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}
