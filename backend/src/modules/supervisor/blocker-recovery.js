// Coordinates durable SL-to-Architecture blocker jobs with call auditing, restart fencing and terminal audit.
import { createDiscoveryCheckpointWriter, discoveryAssignment } from "./blocker-discovery-checkpoint.js";
import { blockerDigest, BLOCKER_REASONS } from "./blocker-recovery-contract.js";
import { transitionCoderCandidate } from "./blocker-coder-candidate.js";
import { scheduleTechnicalReconciliation } from "./blocker-technical-reconciliation.js";
import { returnArchitectureResponse } from "./blocker-architecture-response.js";
import { restoreSprintRecovery } from "./blocker-sprint-handoff.js";
import { completeWaitingWork } from "./blocker-waiting-work.js";
import { recordCriterionUpdates } from "./blocker-ticket-progress.js";
import { blockerResponseEvidence } from "./blocker-validation.js";
import { createBlockerOwnerFollowUp } from "./blocker-owner-follow-up.js";
import { scheduleApprovalRetry } from "./blocker-approval-retry.js";
import { repeatedDispositionCorrection, salvagePersistedDisposition } from "./blocker-disposition-correction.js";
import { isBlockerSourceRetry } from "./blocker-source-retry.js";
import { blockerRecoveryError, createBlockerWaitingRefresh } from "./blocker-recovery-errors.js";
import { assignReviewerEvidence, returnReviewerEvidence } from "./blocker-reviewer-evidence.js";

const STORE = "blocker.recovery";
const PENDING = ["pending", "invoking", "resume_pending", "dispatching", "notification_pending", "notifying", "approval_retry_pending"];
const SALVAGED = Symbol("salvaged");
// Creates execution-wide coordination with deadlines and resume auditing; unknown provider launches are never reclaimed or replayed.
export function createBlockerRecovery({ store, validate, investigate, checkDisposition, resume, notify, clock = Date.now, logger = console,
  deadlineMs = 600_000, refreshWaiting = async () => false } = {}) {
  if (!store?.withLock || ![validate, investigate, checkDisposition, resume, notify].every((callback) => typeof callback === "function")
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 3_600_000) throw new Error("Blocker recovery requires fenced callbacks and a finite deadline.");
  let active = false;
  let timer;
  const followOwnerDecision = createBlockerOwnerFollowUp({ store, clock, deadlineMs });
  const refresh = createBlockerWaitingRefresh({ refreshWaiting, logger, clock });
  return Object.freeze({ enqueue, tick, start, stop, hasPending, cancel, resumeStage, reconcileInterrupted, followOwnerDecision });
  // Gives each newly observed Coder failure a full recovery window while preserving deadlines for duplicate delivery and restart.
  async function enqueue(input) {
    if (!BLOCKER_REASONS.includes(input.reason_code)) return null;
    const request = input.request;
    if (!request?.project_id || !request.task_id || !request.payload?.execution_id || !request.execution_context?.source_revision) return null;
    const id = blockerDigest([request.project_id, request.task_id, request.payload.execution_id]);
    const jobId = blockerDigest([id, input.failure_at, ...["source_revision", "base_sha", "manifest_sha", "review_commit_sha"].map((field) => request.execution_context[field]), input.reason_code]);
    return store.withLock(STORE, async () => {
      const ledger = (await store.list(STORE)).find((entry) => entry.id === id)
        ?? { id, project_id: request.project_id, task_id: request.task_id, execution_id: request.payload.execution_id,
          calls: 0, resumes: 0, deadline_at: clock() + deadlineMs, policy: {}, jobs: [] };
      const existing = ledger.jobs.find((job) => job.id === jobId);
      if (ledger.cancelled) return existing ?? null;
      if (existing) { if (scheduleApprovalRetry(existing, input.approval_retry, clock())) await store.save(STORE, ledger); return existing; }
      const job = { ...structuredClone(input), id: jobId, stage: "sprint_leader", status: "pending", created_at: clock(), history: [] };
      ledger.deadline_at = job.created_at + deadlineMs;
      delete job.approval_retry; scheduleApprovalRetry(job, input.approval_retry, clock());
      ledger.jobs.push(job);
      await store.save(STORE, ledger);
      return job;
    });
  }
  // Exposes pending recovery to explicit RUN so it cannot replace an execution being investigated.
  async function hasPending({ projectId, taskId, executionId }) {
    return (await store.list(STORE)).some((ledger) => ledger.project_id === projectId && ledger.task_id === taskId
      && ledger.execution_id === executionId && !ledger.cancelled && ledger.jobs.some((job) => PENDING.includes(job.status)));
  }
  // Cancels future work without pretending a running or unknown provider invocation has ended.
  async function cancel({ projectId, taskId, executionId }) {
    await store.withLock(STORE, async () => {
      for (const ledger of await store.list(STORE)) {
        if (ledger.project_id !== projectId || ledger.task_id !== taskId || ledger.execution_id !== executionId) continue;
        ledger.cancelled = true;
        for (const job of ledger.jobs) if (PENDING.includes(job.status)) { job.status = "cancelled"; job.outcome_reason = "owner_cancelled"; }
        await store.save(STORE, ledger);
      }
    });
  }
  // Clears a retained interrupted-provider job after reconciliation so a read-only stage may be re-armed without silently replaying an unowned call.
  async function reconcileInterrupted({ projectId, taskId, executionId, jobId }) {
    return store.withLock(STORE, async () => {
      const ledger = (await store.list(STORE)).find((entry) => entry.project_id === projectId && entry.task_id === taskId && entry.execution_id === executionId);
      const job = jobId ? ledger?.jobs.find((entry) => entry.id === jobId) : ledger?.jobs.at(-1);
      if (!ledger || !job) return null;
      if (job.status !== "reconciliation_required" || !["provider_outcome_unknown", "BLOCKER_PROVIDER_UNKNOWN"].includes(job.outcome_reason))
        throw new Error("Only a retained unknown-provider blocker stage can be reconciled.");
      job.outcome_reason = "provider_interrupted_reconciled";
      await store.save(STORE, ledger);
      return structuredClone(job);
    });
  }
  // Re-arms a stopped or known-error stage at its current role position without replaying unknown provider calls.
  async function resumeStage({ projectId, taskId, executionId, jobId }) {
    return store.withLock(STORE, async () => {
      const ledger = (await store.list(STORE)).find((entry) => entry.project_id === projectId && entry.task_id === taskId && entry.execution_id === executionId);
      const job = jobId ? ledger?.jobs.find((entry) => entry.id === jobId) : ledger?.jobs.at(-1);
      if (!ledger || !job || !["cancelled", "reconciliation_required"].includes(job.status)
        || ["provider_outcome_unknown", "BLOCKER_PROVIDER_UNKNOWN"].includes(job.outcome_reason)) return null;
      if (!job.approval_retry) restoreSprintRecovery(job, clock());
      ledger.cancelled = false;
      ledger.deadline_at = clock() + deadlineMs;
      if (job.technical_reconciliation) job.technical_reconciliation.max_rounds = null;
      job.status = job.approval_retry ? "approval_retry_pending" : "pending";
      if (job.approval_retry) job.approval_retry.available_at = clock() + job.approval_retry.interval_ms;
      delete job.outcome_reason;
      delete job.last_error;
      await store.save(STORE, ledger);
      return structuredClone(job);
    });
  }

  // Reserves a single stage under an interprocess lock before contacting any provider.
  async function tick() {
    const work = await store.withLock(STORE, async () => {
      for (const ledger of await store.list(STORE)) for (const job of ledger.jobs) {
        const refreshed = !ledger.cancelled && (job.status === "reconciliation_required" || isBlockerSourceRetry(job)) ? await refresh(job) : false;
        if (refreshed === null) continue;
        if (refreshed) {
          job.stage = job.stage === "reviewer" ? "reviewer" : job.resolution?.action === "architecture_required" ? "architecture_manager" : "sprint_leader";
          job.history.push({ stage: job.stage, event: job.stage === "architecture_manager" ? "authority_wait_assigned" : job.outcome_reason === "EXECUTION_ADMISSION_EVIDENCE_REQUIRED" ? "admission_wait_corrected" : "verification_wait_completed", completed_at: clock() });
          job.status = job.resolution?.action === "resolved" ? "resume_pending" : "pending"; ledger.deadline_at = clock() + deadlineMs;
          delete job.outcome_reason; delete job.last_error;
        }
        const resumeLimited = job.outcome_reason === "resume_budget_exhausted" && job.resolution?.action === "resolved";
        if (!ledger.cancelled && ["reconciliation_required", "notification_pending"].includes(job.status)
          && (resumeLimited || ["triage_budget_exhausted", "disposition_correction_budget_exhausted", "technical_reconciliation_rounds_exhausted"].includes(job.outcome_reason))
          && clock() < ledger.deadline_at) {
          job.history.push({ stage: job.stage, event: resumeLimited ? "resume_limit_removed" : "call_limit_removed",
            previous_outcome_reason: job.outcome_reason, ...(resumeLimited ? { previous_resolution: job.resolution } : {}), completed_at: clock() });
          if (resumeLimited) delete job.resolution;
          if (job.technical_reconciliation) job.technical_reconciliation.max_rounds = null;
          job.status = "pending";
          delete job.outcome_reason;
        }
        if (!PENDING.includes(job.status) || ledger.cancelled || job.status === "approval_retry_pending" && clock() < job.approval_retry.available_at) continue;
        if (job.status === "notifying") {
          if (clock() < job.notification_until) continue;
          job.status = "notification_pending";
        }
        if (!await validate(job)) { job.status = "cancelled"; job.outcome_reason = "stale_execution_or_source"; await store.save(STORE, ledger); continue; }
        if (["invoking", "dispatching"].includes(job.status)) {
          if (clock() < ledger.deadline_at) continue;
          job.outcome_reason = "provider_outcome_unknown"; job.status = "notification_pending";
        }
        if (job.status === "pending" && clock() >= ledger.deadline_at) {
          job.outcome_reason = "triage_deadline_exhausted"; job.status = "notification_pending";
        }
        if (job.status === "resume_pending" && clock() >= ledger.deadline_at) {
          job.outcome_reason = "resume_deadline_exhausted"; job.status = "notification_pending";
        }
        const operation = job.status;
        if (operation === "pending") { ledger.calls += 1; job.status = "invoking"; job.invocation_id = blockerDigest([job.id, ledger.calls, clock()]); }
        if (["resume_pending", "approval_retry_pending"].includes(operation)) { ledger.resumes += 1; job.status = "dispatching"; if (operation === "approval_retry_pending") ledger.deadline_at = clock() + deadlineMs; }
        if (operation === "notification_pending") { job.status = "notifying"; job.notification_until = clock() + 5000; }
        await store.save(STORE, ledger);
        return { ledgerId: ledger.id, job: structuredClone(job), operation, deadline: ledger.deadline_at };
      }
      return null;
    });
    if (!work) return null;
    const { job, operation } = work;
    try {
      if (operation === "notification_pending") {
        await notify(job);
        return update(work, (current) => { current.status = ["owner_required", "governance_required"].includes(current.resolution?.action) && current.stage === "architecture_manager" ? current.resolution.action : "reconciliation_required"; });
      }
      if (["resume_pending", "approval_retry_pending"].includes(operation)) {
        if (operation !== "approval_retry_pending") await checkDisposition(job.resolution, job);
        await resume(job);
        return update(work, (current) => { current.status = "resumed"; });
      }
      const retained = await salvagePersistedDisposition({ work, job, update, checkDisposition });
      const response = retained ? { [SALVAGED]: retained } : await investigateAndRecord(work, job);
      if (!response) return null;
      const value = response[SALVAGED] ?? await checkDisposition(response, job);
      return update(work, (current) => {
        current.disposition_attempts.at(-1).status = "accepted";
        if (current.stage === "sprint_leader" && value.action === "architecture_required") current.consultation_request = current.communication?.consultation ?? null;
        delete current.validation_feedback;
        delete current.last_error;
        current.history.push({ stage: current.stage, disposition: value, completed_at: clock(), actor: current.invocation_actor ?? null });
        recordCriterionUpdates(current, value);
        completeWaitingWork(current, value, clock());
        if (assignReviewerEvidence(current, value, clock()) || returnReviewerEvidence(current, value, clock())) return;
        if (returnArchitectureResponse(current, value, clock())) return;
        if (transitionCoderCandidate(current, value, clock())) return;
        if (value.action === "resolved") { current.resolution = value; current.status = "resume_pending"; }
        else if (value.action === "reconciliation_required") {
          scheduleTechnicalReconciliation(current, value, clock());
        }
        else if (current.stage === "sprint_leader") { current.resolution = value; current.stage = "architecture_manager"; current.status = "pending"; }
        else if (["owner_required", "governance_required"].includes(value.action)) { current.resolution = value; current.status = "notification_pending"; current.outcome_reason = value.action === "governance_required" ? "contract_revision_required" : "authority_required"; }
        else { current.status = "notification_pending"; current.outcome_reason = "unresolved_after_architecture"; }
      });
    } catch (error) {
      if (!error.not_started) logger.error?.("Blocker recovery stage failed.", { task_id: job.request.task_id, stage: job.stage, code: error.code, error: error.message, validation_errors: error.validation_errors });
      return update(work, (current, ledger) => {
        if (error.not_started && operation === "pending") { current.status = "pending"; current.last_error = error.message; ledger.calls -= 1; }
        else {
          const feedback = error.validation_errors ?? [{ path: "/", reason: error.code ?? "BLOCKER_RECOVERY_FAILED", message: error.message }];
          if (operation === "notification_pending" && current.resolution?.action === "governance_required") {
            current.failed_governance_disposition = current.resolution;
            delete current.resolution;
          }
          if (operation === "pending") {
            current.disposition_attempts ??= [];
            if (error.response_evidence) current.disposition_attempts.push({ stage: current.stage, assignment_id: discoveryAssignment(job), status: "received", received_at: clock(), response: error.response_evidence });
            const attempt = current.disposition_attempts.at(-1);
            if (attempt?.status === "received") Object.assign(attempt, { status: "rejected", validation_errors: feedback });
          }
          const correctable = operation === "pending" && error.code === "BLOCKER_DISPOSITION_INVALID" && error.retryable_disposition === true;
          const repeated = correctable && repeatedDispositionCorrection(current, feedback);
          const repairable = correctable && !repeated && clock() < ledger.deadline_at;
          current.status = repairable ? "pending" : "notification_pending";
          current.validation_feedback = feedback;
          if (!repairable) current.outcome_reason = repeated ? "disposition_correction_no_progress" : correctable
            ? "disposition_correction_deadline_exhausted"
            : error.code ?? "BLOCKER_RECOVERY_FAILED";
          current.last_error = repeated ? `Unchanged invalid disposition for ${feedback.map((entry) => entry.path).join(", ")}; automatic correction stopped at the retained checkpoint. ${error.message}` : error.message;
        }
      });
    }
  }

  // Invokes the stage provider and records its raw response evidence before disposition validation.
  async function investigateAndRecord(work, job) {
    const response = await investigate(job, { deadline: work.deadline, onDiscoveryCheckpoint: createDiscoveryCheckpointWriter({ store, ledgerId: work.ledgerId, job, validate }),
      onAgentSelected: async (actor) => { job.invocation_actor = actor; if (!await update(work, (current) => { current.invocation_actor = actor; })) throw new Error("Investigation ownership changed before provider dispatch."); },
      onCommunication: async (communication) => { if (!await update(work, (current) => { current.communication = { ...current.communication, ...communication }; })) throw new Error("Communication no longer owns the recovery assignment."); },
      onTicketProgress: async (progress) => { if (!await update(work, (current) => { current.ticket_progress = progress; })) throw new Error("Ticket progress reservation changed; do not invoke provider."); } });
    const saved = await update(work, (current) => {
      current.disposition_attempts ??= [];
      current.disposition_attempts.push({ stage: current.stage, assignment_id: discoveryAssignment(job), status: "received", received_at: clock(), response: blockerResponseEvidence(response) });
    });
    return saved ? response : null;
  }

  // Writes results only for the stage that still owns the persisted invocation reservation.
  async function update(work, change) {
    return store.withLock(STORE, async () => {
      const ledger = (await store.list(STORE)).find((entry) => entry.id === work.ledgerId);
      const job = ledger.jobs.find((entry) => entry.id === work.job.id);
      if (ledger.cancelled || job.status !== work.job.status || job.stage !== work.job.stage || job.invocation_id !== work.job.invocation_id) return null;
      change(job, ledger);
      await store.save(STORE, ledger);
      return job;
    });
  }

  // Starts a serialized local poller; persisted stage claims coordinate other processes.
  async function start() { if (active) return; active = true; void poll(); }

  // Stops local polling without clearing durable work or resetting its deadline.
  function stop() { active = false; clearTimeout(timer); }

  // Reports adapter failures and keeps pending work observable instead of silently dropping it.
  async function poll() {
    try { await tick(); } catch (error) { logger.error?.(`Blocker recovery poll failed: ${error.message}`, blockerRecoveryError(error)); }
    finally { if (active) { timer = setTimeout(poll, 1000); timer.unref?.(); } }
  }
}
