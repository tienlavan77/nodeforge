// Detects declared missing contract prerequisites before Coder starts and routes discovery into automatic triage.
import { validateBlockerDisposition } from "./blocker-recovery-contract.js";
import { handleTicketExecutionFailure } from "./ticket-execution-failure.js";
import { assertApprovedTicket } from "../governance/sprint-plan-draft.js";

// Verifies contract evidence or records a structured blocker without launching or blaming a Coder.
export async function preflightBlockerContract(request, { sprintRegistry, resolveTicketWorkspace, checkpoints, eventBus, projectLogger, agentOccupancy }) {
  const policy = request.ticket.execution_policy;
  if (policy?.requires_existing_contract !== true) return false;
  const { plan } = await sprintRegistry.assertReady(request.ticket.sprint_id, { expectedVersion: request.payload.sprint_basis.version });
  assertApprovedTicket(plan, request.ticket);
  const workspace = await resolveTicketWorkspace(request.task_id);
  try {
    const refs = policy.contract_evidence ?? [];
    if (!refs.length) throw Object.assign(new Error("Declared existing contract has no verified evidence."), { code: "BLOCKER_DISPOSITION_INVALID" });
    for (const ref of refs) await validateBlockerDisposition({ action: "resolved", summary: "Check declared existing contract prerequisite.",
      guidance: "Use the existing approved contract without altering its public semantics.", authority_quote: ref.authority_quote,
      evidence: [{ path: ref.path, sha256: ref.sha256 }] }, { job: { request, reason_code: "CONTRACT_DECISION_REQUIRED" }, plan,
      fileService: workspace.root_only ? workspace.fileService : workspace.worktreeFileService ?? workspace.fileService, projectRoot: workspace.path ?? workspace.projectRoot });
    return false;
  } catch (error) {
    if (!["BLOCKER_DISPOSITION_INVALID", "ENOENT", "FILE_NOT_FOUND", "FILE_ROLE_FORBIDDEN", "PATH_INVALID", "PATH_TRAVERSAL"].includes(error.code)) throw error;
    projectLogger?.({ event_name: "ticket.contract_preflight_blocked", level: "warn", status: "blocked", task_id: request.task_id,
      message: "Declared contract prerequisite requires automatic discovery before Coder dispatch.", payload: { reason: error.message } });
    const failure = Object.assign(new Error(`Existing contract prerequisite is missing or stale: ${error.message}`), { code: "CODER_BLOCKED",
      details: { blocker: { reason_code: "CONTRACT_DECISION_REQUIRED" }, evidence: policy.contract_evidence ?? [] } });
    await handleTicketExecutionFailure({ error: failure, failedRequest: request, taskId: request.task_id, ownerId: request.supervisor_id,
      checkpoints, agentOccupancy, projectLogger, publishTicketOutcome: (type, failed, supervisorId, outcome) => eventBus.publish({
        type, task_id: failed.task_id, project_id: failed.project_id, supervisor_id: supervisorId, request_id: failed.request_id,
        correlation_id: failed.correlation_id, attempt: 1, payload: { ...outcome, execution_id: failed.payload.execution_id, execution_basis: failed.payload.sprint_basis } }) });
    return true;
  }
}
