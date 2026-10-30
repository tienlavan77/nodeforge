// Builds durable upstream repair and parent wait evidence with real SQLite, checkpoint and journal stores.
// SDK behavior is injected so tests can prove coordination boundaries without running a model or touching project state.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";
import { createAgentExecutionCheckpointStore } from "../../src/modules/agent/agent-execution-checkpoint.js";
import { createFileQueueStore } from "../../src/modules/supervisor/file-queue-store.js";
import { createTicketExecutionContextStore } from "../../src/modules/supervisor/ticket/ticket-execution-context.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket/ticket-change-ledger.js";
import { prepareCompletedReviewRepair } from "../../src/modules/supervisor/review/completed-review-repair-workspace.js";
import { createDependencyRepairCoordinator } from "../../src/modules/supervisor/coder/dependency-repair-coordinator.js";

// Preserves actual launch identity and original source while exposing deterministic repair outcomes and time.
export async function dependencyRepairFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "nf-dependency-repair-"));
  const database = await createDatabaseService({ dataDir: root });
  t.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
  const files = createFileService({ projectRoot: root });
  const statuses = createTicketStatusStore({ database, projectId: "P" });
  const checkpoints = createAgentExecutionCheckpointStore({ fileService: files });
  const store = createFileQueueStore({ fileService: files });
  const basis = { project_id: "P", sprint_id: "S", plan_id: "PLAN", plan_revision: 1, plan_path: "plan.json", plan_sha256: "a".repeat(64), version: 1, status: "ready" };
  const specs = ["UP", "MID", "PARENT", "OTHER"].map((id) => ({ id, project_id: "P", sprint_id: "S", dependencies: id === "PARENT" ? ["MID"] : id === "MID" ? ["UP"] : [] }));
  const plan = { content: { tickets: specs.map((ticket) => ticket.id), ticket_specs: specs } };
  const registry = { get: () => basis, getByTicket: async () => basis, assertReady: async (id, { expectedVersion }) => {
    if (id !== "S" || expectedVersion !== basis.version) throw new Error("Approved Sprint changed.");
    return { sprint: basis, plan };
  } };
  for (const ticket of specs) {
    statuses.create(ticket.id); statuses.beginExecution(ticket.id, { executionId: `RUN-${ticket.id}`, basis, expectedVersion: 0, dependencyExpectations: [] });
    statuses.updateStatus(ticket.id, ticket.id === "PARENT" ? "needs_human_review" : "done");
  }
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const scope = hash("P");
  const manifest = { task_id: "UP", project_id: "P", state: "closed", revision: 8, entries: {}, commits: { 8: "b".repeat(40) }, pending_commit: null };
  const contexts = createTicketExecutionContextStore({ projectId: "P", projectRoot: root, fileService: files });
  const contextPath = `.forge/runtime/ticket-execution-contexts/${scope}/UP.json`;
  const context = { task_id: "UP", project_id: "P", version: 3, state: "terminal", base_sha: "a".repeat(40),
    ...contexts.manifestIdentity(manifest), review_commit_sha: "b".repeat(40), verification_artifact_id: "ARTIFACT-OLD" };
  await files.atomicWrite({ path: `.forge/runtime/ticket-changes/${scope}/tickets/${hash("UP")}.json`, content: JSON.stringify(manifest) });
  await files.atomicWrite({ path: contextPath, content: JSON.stringify(context) });
  await files.atomicWrite({ path: ".forge/runtime/ticket-integrations/UP.json", content: JSON.stringify({ status: "completed", commit: context.review_commit_sha, artifact_id: context.verification_artifact_id }) });
  await files.atomicWrite({ path: "source.js", content: "unrelated source stays intact\n" });
  await checkpoints.complete("UP", { agent_id: "CODER", provider: "claude", session_id: "SDK-SESSION", last_completed_turn: 36, changed_paths: ["old.js"], execution_context: context });
  await checkpoints.saveReview({ task_id: "UP", status: "completed", verdict: "approved", request_id: "OLD-REVIEW", commit: context.review_commit_sha,
    verification: { artifact_id: context.verification_artifact_id }, execution_context: context, reviewer_id: "REVIEWER", coder_id: "CODER" });
  const parent = { task_id: "PARENT", status: "blocked", last_completed_turn: 19, failure: { at: "original", code: "CODER_BLOCKED" } };
  await checkpoints.save(parent);
  const job = { id: "BLOCKER", stage: "sprint_leader", status: "dependency_wait", history: [], request: { task_id: "PARENT", project_id: "P",
    ticket: specs.find((entry) => entry.id === "PARENT"), payload: { execution_id: "RUN-PARENT", sprint_basis: basis } } };
  const value = { action: "dependency_requested", summary: "Repair approved upstream behavior.", authority_scope: "sprint", guidance: "Keep the parent checkpoint while UP repairs.",
    dependency_request: { ticket_id: "UP", reason: "The parent needs the missing frontend behavior.", instructions: "Repair the saved indicator under the settled contract.",
      expected_results: ["New accepted commit and verification."], evidence_refs: ["failure-receipt.json"] } };
  await store.save("blocker.recovery", { id: "LEDGER", task_id: "PARENT", project_id: "P", execution_id: "RUN-PARENT", jobs: [job] });
  const ledger = createTicketChangeLedger({ projectId: "P", fileService: files });
  let artifact;
  const workspace = { executionContexts: contexts, changeLedger: { load: () => ledger.load("UP") }, beginReviewRepair: ({ binding, cycleId }) => prepareCompletedReviewRepair({ taskId: "UP", projectId: "P", fileService: files, executionContexts: contexts, ledger, binding, cycleId }),
    testService: { assertPassedArtifact: async () => artifact } };
  const state = { now: 1000, launches: [], logs: [], cancelled: new Set() };
  const services = { store, fileService: files, ticketStatusStore: statuses, sprintRegistry: registry, checkpoints, resolveTicketWorkspace: async () => workspace,
    disposition: { get: async (id) => state.cancelled.has(id) ? { disposition: "cancelled" } : null }, clock: () => state.now,
    projectLogger: (entry) => state.logs.push(entry), dispatchTicket: async (input) => { state.launches.push(input); return options.dispatch ? options.dispatch(input) : { status: "accepted" }; } };
  const coordinator = createDependencyRepairCoordinator(services);
  t.after(() => coordinator.stop());
  // Binds the accepted SL request exactly as the blocker state machine does after validation.
  async function request() {
    const id = await coordinator.request(job, value);
    job.dependency_request_id = id;
    await store.save("blocker.recovery", { id: "LEDGER", task_id: "PARENT", project_id: "P", execution_id: "RUN-PARENT", jobs: [job] });
    return id;
  }
  // Produces a new independently approved repair result while retaining the original execution identity.
  async function complete(id) {
    const current = await contexts.load("UP");
    artifact = { project_id: "P", task_id: "UP", artifact_id: "ARTIFACT-NEW", commit_sha: "c".repeat(40), source_revision: "source-new" };
    const context = { ...current, state: "terminal", source_revision: artifact.source_revision, review_commit_sha: artifact.commit_sha, verification_artifact_id: artifact.artifact_id };
    await files.atomicWrite({ path: contextPath, content: JSON.stringify(context), replace: true });
    await checkpoints.saveReview({ task_id: "UP", request_id: `REVIEW-${id}`, status: "in_progress", verdict: null, execution_context: context });
    await checkpoints.completeReview("UP", { verdict: "approved", commit: artifact.commit_sha, verification: artifact, reviewer_id: "REVIEWER", coder_id: "CODER" });
    const currentStatus = statuses.get("UP");
    if (currentStatus.status === "pending") statuses.resumeReviewExecution("UP", { executionId: "RUN-UP", basis, expectedVersion: currentStatus.version,
      dependencyExpectations: currentStatus.details.dependency_expectations, validate: () => {} });
    statuses.updateStatus("UP", "reviewing", { ...statuses.get("UP").details });
    await files.atomicWrite({ path: ".forge/runtime/ticket-integrations/UP.json", content: JSON.stringify({ task_id: "UP", status: "completed",
      commit: artifact.commit_sha, artifact_id: artifact.artifact_id, source_revision: artifact.source_revision }), replace: true });
    statuses.updateStatus("UP", "done", { ...statuses.get("UP").details });
  }
  return { root, files, statuses, checkpoints, store, basis, specs, registry, plan, contexts, context, contextPath, job, value, state, services, coordinator, request, complete };
}

// Waits for detached preparation only, avoiding sleeps tied to provider or polling intervals.
export async function waitForDependency(f, predicate) {
  for (let index = 0; index < 300; index++) {
    const entry = await f.store.withLock("ticket.dependency-repair", async () => (await f.store.list("ticket.dependency-repair"))[0]);
    if (predicate(entry)) return entry;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Dependency repair did not reach the expected test boundary.");
}
