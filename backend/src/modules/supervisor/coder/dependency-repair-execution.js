// Prepares a target's repair journal and original Coder checkpoint for the ordinary RUN pipeline.
// A transactional preparation reservation prevents concurrent RUN from consuming a half-reopened journal.
import { statePath } from "../../../infrastructure/filesystem/forge-paths.js";
import { acquireTicketFileLock } from "../ticket/ticket-file-lock.js";
import { dependencyRepairError } from "./dependency-repair-contract.js";

// Retains provider session and turn while isolating new writes from the integrated cycle.
// Preparation may finish after parent Stop, but only normal RUN can launch a provider and it rechecks the parent.
export async function prepareDependencyExecution(entry, { resolveTicketWorkspace, checkpoints, ticketStatusStore, fileService,
  isCurrent, validateTarget, saveBinding, disposition, finishOnly = false }) {
  const taskId = entry.target.ticket.id;
  const lock = await acquireTicketFileLock(fileService, `${statePath()}/automatic-review-locks/OWNER-${taskId}.lock`);
  try {
    const current = ticketStatusStore.get(taskId);
    const reserved = current.details.dependency_repair?.id === entry.id;
    if (!await isCurrent(entry) && !(finishOnly && reserved && current.details.dependency_repair.state === "preparing"))
      throw dependencyRepairError("Dependency requester was stopped or replaced.");
    await validateTarget(entry);
    if ((await disposition?.get(taskId))?.disposition === "cancelled") throw dependencyRepairError("Dependency was stopped by its owner.");
    if (current.details.launch_claim || ["running", "reviewing"].includes(current.status)) return null;
    if (!["done", "failed", "pending"].includes(current.status) || current.details.reason === "TICKET_STOPPED")
      throw dependencyRepairError("Dependency is stopped or requires its own unresolved decision.");
    if ((await checkpoints.loadReview(taskId))?.status === "in_progress") return null;
    const coder = await checkpoints.load(taskId);
    if (!coder || coder.status === "blocked" || coder.failure?.code === "TICKET_STOPPED")
      throw dependencyRepairError("Dependency has no runnable retained Coder checkpoint.");
    if (current.details.execution_id !== entry.target.execution_id) throw dependencyRepairError("Dependency execution changed after SL requested repair.");
    if (reserved && current.details.dependency_repair.state === "ready" && coder.dependency_repair?.id === entry.id) {
      if (coder.phase === "dependency_repair" && coder.review_repair_key) {
        const resumed = dependencyRepairCheckpoint(coder);
        await checkpoints.save(resumed);
        return resumed;
      }
      return coder;
    }
    if (current.status !== "done" && !reserved)
      throw dependencyRepairError("Upstream ticket must finish its current execution before a separate dependency repair can be prepared.", "DEPENDENCY_REPAIR_TARGET_NOT_READY");
    const workspace = await resolveTicketWorkspace(taskId);
    const context = await workspace.executionContexts.load(taskId);
    const binding = entry.integrated_binding ?? { job_id: entry.id, commit: context?.review_commit_sha, artifact_id: context?.verification_artifact_id };
    if (!binding.commit || !binding.artifact_id || !workspace.beginReviewRepair) throw dependencyRepairError("Integrated dependency repair evidence or journal service is unavailable.");
    if (!entry.integrated_binding && !await saveBinding(entry, binding)) throw dependencyRepairError("Dependency request changed during journal preparation.");
    entry.integrated_binding = binding;
    const reservation = ticketStatusStore.prepareDependencyRepair(taskId, { executionId: entry.target.execution_id, basis: entry.target.basis,
      expectedVersion: current.version, binding: { id: entry.id, parent_ticket_id: entry.parent.task_id,
        parent_execution_id: entry.parent.execution_id, receipt: entry.receipt, state: "preparing" }, validate: () => {} });
    const prepared = await workspace.beginReviewRepair({ binding, cycleId: entry.id });
    const resumed = dependencyRepairCheckpoint(coder.dependency_repair?.id === entry.id ? coder : { ...coder, status: "in_progress", phase: "dependency_repair", dependency_repair: {
      id: entry.id, parent_ticket_id: entry.parent.task_id, ...entry.request }, review_cycle_id: entry.id,
      failure: null, failure_request_id: null, blocker_recovery: null, completed_at: null, verification_wait: null, sdk_turn_progress: null, agent_exchange: null,
      changed_paths: [], completed_tools: [], read_cache: {}, coder_rules_read: false, review_stage: null,
      execution_context: await workspace.executionContexts.load(taskId) });
    const latest = ticketStatusStore.get(taskId);
    if (latest.version !== reservation.version || latest.details.execution_id !== entry.target.execution_id)
      throw dependencyRepairError("Dependency changed during journal preparation.");
    await checkpoints.save(resumed);
    ticketStatusStore.prepareDependencyRepair(taskId, { executionId: entry.target.execution_id, basis: entry.target.basis,
      expectedVersion: reservation.version, binding: { ...reservation.details.dependency_repair, receipt: prepared.receipt, state: "ready" }, validate: () => {} });
    return resumed;
  } finally { await lock.release(); }
}

// Retains the SDK session and settled decisions while retiring commands and findings from the archived repair cycle.
function dependencyRepairCheckpoint(coder) {
  const resumed = { ...coder };
  delete resumed.review_repair_key;
  delete resumed.repair_implementation_required;
  delete resumed.review_findings;
  return resumed;
}

// Accepts only this repair's matching verification, integration and independent review receipts.
export async function dependencyRepairCompletion(entry, { resolveTicketWorkspace, checkpoints, ticketStatusStore, fileService }) {
  const taskId = entry.target.ticket.id;
  const current = ticketStatusStore.get(taskId);
  if (current?.status !== "done" || current.details.dependency_repair?.id !== entry.id || current.details.execution_id !== entry.target.execution_id) return null;
  const workspace = await resolveTicketWorkspace(taskId);
  const context = await workspace.executionContexts.load(taskId);
  const review = await checkpoints.loadReview(taskId);
  if (context?.project_id !== entry.parent.project_id || context?.task_id !== taskId || context?.review_repair_cycle_id !== entry.id
    || !review?.reviewer_id || !review?.coder_id || review.reviewer_id === review.coder_id
    || review.execution_context?.review_repair_cycle_id !== entry.id || context?.state !== "terminal"
    || context.verification_artifact_id !== review?.verification?.artifact_id || context.review_commit_sha !== review?.commit
    || review.status !== "completed" || review.verdict !== "approved") return null;
  const artifact = await workspace.testService.assertPassedArtifact();
  if (artifact.project_id !== entry.parent.project_id || artifact.task_id !== taskId || artifact.artifact_id !== context.verification_artifact_id
    || artifact.commit_sha !== context.review_commit_sha || artifact.source_revision !== context.source_revision
    || review.verification.source_revision !== artifact.source_revision) return null;
  let integration;
  try { integration = JSON.parse(await fileService.readFile({ path: `${statePath()}/ticket-integrations/${taskId}.json` })); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (integration.task_id !== taskId || integration.status !== "completed" || integration.commit !== artifact.commit_sha
    || integration.artifact_id !== artifact.artifact_id || integration.source_revision !== artifact.source_revision) return null;
  return { ticket_id: taskId, execution_id: current.details.execution_id, commit_sha: context.review_commit_sha,
    artifact_id: artifact.artifact_id, source_revision: context.source_revision, review: "approved" };
}
