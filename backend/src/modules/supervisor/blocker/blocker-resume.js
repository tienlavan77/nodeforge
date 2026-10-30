// Resumes resolved blocker work through the original execution gates while retaining a recoverable checkpoint when dispatch cannot start.
import { assertTicketCoderAvailable } from "../ticket/ticket-agent-availability.js";
import { buildBlockerTicketProgress } from "./blocker-ticket-progress.js";
import { blockerDigest } from "./blocker-recovery-contract.js";
import { recordTicketStage } from "../ticket/ticket-stage-progress.js";
import { retainBlockerContract } from "./blocker-contract-evidence.js";
import { assertDependencyExpectations } from "../ticket/ticket-dependency-expectations.js";
import { matchesTicketExecution } from "../../projects/ticket-execution-identity.js";

// Checks Coder occupancy before changing ticket state, and rolls back only an unlaunched attempt under exact execution and version fences.
export function createBlockerResume({ inspect, classifyFailure, checkpoints, sprintRegistry, ticketStatusStore, agentResolver, agentOccupancy,
  store, fileService, submitTicket, logger, clock }) {
  // Resumes unchanged work under its original execution using the same transactional launch and review gates.
  return async function resume(job) {
    const authority = await inspect(job);
    if (!authority) throw new Error("Blocker source changed before resume.");
    assertTicketCoderAvailable({ resolver: agentResolver, occupancy: agentOccupancy, ticket: job.request.ticket, taskId: job.request.task_id, ownerId: job.request.supervisor_id, payload: { ...job.request.payload, resume_from: authority.checkpoint } });
    const ticket_progress = await buildBlockerTicketProgress({ job, ...authority, sprintRegistry, ticketStatusStore, reviewCheckpoint: await checkpoints.loadReview?.(job.request.task_id) });
    ticket_progress.failure_classification = await classifyFailure(job, authority.workspace);
    ticket_progress.evidence_sha256 = blockerDigest([ticket_progress.evidence_sha256, ticket_progress.failure_classification]);
    const { current } = authority;
    const checkpoint = (await recordTicketStage({ checkpoints, taskId: job.request.task_id, stage: "coder", status: "resumed_from_blocker", details: { job_id: job.id }, logger, clock })) ?? authority.checkpoint;
    const resumed = { ...checkpoint, contract_decisions: await retainBlockerContract({ job, checkpoint, fileService }), status: "in_progress", phase: "blocker_resolved", blocker_recovery: {
      job_id: job.id, status: job.approval_retry ? "approval_retry" : "resolved", approval_retry: job.approval_retry ?? null,
      disposition: job.resolution, communication: job.communication ?? null, history: job.history, coder_exchange: job.coder_exchange ?? null, execution_admission: job.execution_admission ?? null, ticket_progress } };
    delete resumed.failure;
    try {
      await store.withLock("blocker.recovery", async () => {
        const ledger = (await store.list("blocker.recovery")).find((entry) => entry.jobs.some((item) => item.id === job.id));
        if (!ledger || ledger.cancelled || ledger.jobs.find((item) => item.id === job.id)?.status !== "dispatching") throw new Error("Blocker resume was cancelled.");
        await checkpoints.save(resumed);
        ticketStatusStore.resumeBlockedExecution(job.request.task_id, { executionId: job.request.payload.execution_id,
          basis: job.request.payload.sprint_basis, expectedVersion: current.version,
          dependencyExpectations: job.request.payload.dependency_expectations,
          validate: () => assertDependencyExpectations({ projectId: job.request.project_id, ticket: job.request.ticket,
            expectations: job.request.payload.dependency_expectations, sprintRegistry, ticketStatusStore }) });
      });
      return await submitTicket({ ...job.request, required_role: job.request.required_role ?? job.request.ticket?.required_role ?? "coder", request_id: `BLOCKER-RESUME-${job.id}`,
        payload: { ...job.request.payload, retry_source_identity: job.request.execution_context, review_cycle_id: authority.checkpoint.review_cycle_id ?? job.request.payload.review_cycle_id, resume_from: resumed } });
    } catch (error) {
      const latest = ticketStatusStore.get(job.request.task_id);
      const saved = await checkpoints.load(job.request.task_id);
      if (matchesTicketExecution(latest, job.request.payload.execution_id, job.request.payload.sprint_basis) && !latest.details.launch_claim
        && saved?.phase === "blocker_resolved" && saved.blocker_recovery?.job_id === job.id
        && ((latest.status === current.status && latest.version === current.version)
          || (latest.status === "running" && latest.version === current.version + 1))) {
        if (latest.status === "running") ticketStatusStore.updateStatus(job.request.task_id, "needs_human_review", { ...latest.details, reason: "blocker_resume_failed" },
          { expectedVersion: latest.version, expectedExecutionId: latest.details.execution_id });
        await checkpoints.save(checkpoint);
      }
      throw error;
    }
  }
}
