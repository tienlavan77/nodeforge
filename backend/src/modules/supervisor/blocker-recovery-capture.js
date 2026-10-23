// Captures parked tickets with approved source identity and retained owner choices for SL/Architecture reconciliation.
import { matchesTicketExecution } from "../projects/ticket-execution-identity.js";
import { approvedTicketDecisions } from "../governance/plan-decision-requests.js";
import { approvedBlockerArchitecture } from "./blocker-decision-authority.js";
import { BLOCKER_REASONS } from "./blocker-recovery-contract.js";
import { recordTicketStage } from "./ticket-stage-progress.js";
import { blockerOwnerDecisions } from "./blocker-owner-decisions.js";
import { restoreRepairBlocker, retainPriorBlockerContracts } from "./blocker-repair-recovery.js";

// Retains only current execution blockers and forwards recorded policy choices without inventing contract approval.
export function createBlockerCapture({ ticketStatusStore, checkpoints, sprintRegistry, architecturePlans, resolveTicketWorkspace, recovery, store, fileService, prepareRetry = async (input) => input, notifyRetry = async () => {}, logger, clock }) {
  return capture;

  // Loads the immutable ticket and source before enqueueing a deduplicated investigation.
  async function capture(taskId, event) {
    const current = ticketStatusStore.get(taskId);
    if (!current?.details?.execution_id || !["running", "needs_human_review"].includes(current.status) || current.details.launch_claim) return;
    if (event && !matchesTicketExecution(current, event.payload?.execution_id, event.payload?.execution_basis)) return;
    let checkpoint = await checkpoints.load(taskId);
    if (checkpoint?.status !== "blocked" || checkpoint.failure?.code !== "CODER_BLOCKED") return;
    const workspace = await resolveTicketWorkspace(taskId);
    checkpoint = await restoreRepairBlocker({ checkpoint, current, store, projectRoot: workspace.projectRoot ?? workspace.path });
    const reason = checkpoint?.triage?.reason_code;
    if (checkpoint?.status !== "blocked" || checkpoint.failure?.code !== "CODER_BLOCKED" || !BLOCKER_REASONS.includes(reason)) return;
    const basis = current.details.execution_basis;
    const { plan } = await sprintRegistry.assertReady(basis.sprint_id, { expectedVersion: basis.version });
    const spec = plan.content.ticket_specs?.find((ticket) => ticket.id === taskId);
    if (!spec) return;
    const ticket = { ...spec, project_id: current.project_id, sprint_id: basis.sprint_id };
    const choices = approvedTicketDecisions(plan, taskId);
    if (choices.length) ticket.owner_decisions = choices;
    const architecture = await approvedBlockerArchitecture(plan, current.project_id, architecturePlans);
    const context = await workspace.executionContexts.load(taskId);
    if (!context || context.project_id !== current.project_id || context.state === "terminal") return;
    checkpoint = await retainPriorBlockerContracts({ checkpoint, current, store, fileService });
    await checkpoints.save(checkpoint);
    const ownerDecisions = blockerOwnerDecisions(checkpoint, current);
    const job = await recovery.enqueue(await prepareRetry({ owner_decisions: ownerDecisions, reason_code: reason, failure_at: checkpoint.failure.at, message: checkpoint.failure.message, architecture_basis: architecture?.basis ?? null,
      evidence: checkpoint.triage.evidence_refs ?? [], coder_consultation: checkpoint.triage.consultation ?? null,
      request: { task_id: taskId, project_id: current.project_id, agent_id: checkpoint.agent_id ?? null, ticket, required_role: ticket.required_role ?? "coder",
        supervisor_id: `SUP-${taskId}`, request_id: checkpoint.failure_request_id ?? event?.request_id ?? `BLOCKED-${checkpoint.failure.at}`,
        correlation_id: checkpoint.correlation_id ?? `CORR-${taskId}`, execution_context: context,
        payload: { execution_id: current.details.execution_id, sprint_basis: basis, dependency_expectations: current.details.dependency_expectations } } }));
    const latest = await checkpoints.load(taskId);
    if (job?.status === "pending" && latest?.failure?.at === checkpoint.failure.at) await checkpoints.save({ ...latest,
      blocker_owner_decisions: ownerDecisions, phase: "blocker_triage_pending", blocker_recovery: { job_id: job.id, status: "pending", reason_code: reason } });
    if (job) await recordTicketStage({ checkpoints, taskId, stage: job.approval_retry ? "coder" : "sprint_leader", status: job.status === "pending" ? "in_progress" : job.status, details: { job_id: job.id }, logger, clock });
    await notifyRetry(job);
    return job;
  }
}
