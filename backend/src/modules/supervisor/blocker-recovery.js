// Coordinates durable SL-to-Architecture blocker jobs with bounded calls, restart fencing and terminal audit.
import { blockerDigest, BLOCKER_REASONS } from "./blocker-recovery-contract.js";
import { blockerResponseEvidence } from "./blocker-validation.js";

const STORE = "blocker.recovery";
const PENDING = ["pending", "invoking", "resume_pending", "dispatching", "notification_pending", "notifying"];
const SALVAGED = Symbol("salvaged");

// Creates one execution-wide budget; unknown provider launches are never reclaimed or replayed.
export function createBlockerRecovery({ store, validate, investigate, checkDisposition, resume, notify, clock = Date.now, logger = console,
  maxCalls = 4, maxResumes = 2, deadlineMs = 600_000 } = {}) {
  if (!store?.withLock || ![validate, investigate, checkDisposition, resume, notify].every((callback) => typeof callback === "function")
    || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 8 || !Number.isSafeInteger(maxResumes) || maxResumes < 1 || maxResumes > 2
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 3_600_000) throw new Error("Blocker recovery requires fenced callbacks and finite limits.");
  let active = false;
  let timer;
  return Object.freeze({ enqueue, tick, start, stop, hasPending, cancel, resumeStage, reconcileInterrupted });

  // Deduplicates failure redelivery while preserving the budget across new revisions and provider changes.
  async function enqueue(input) {
    if (!BLOCKER_REASONS.includes(input.reason_code)) return null;
    const request = input.request;
    if (!request?.project_id || !request.task_id || !request.payload?.execution_id || !request.execution_context?.source_revision) return null;
    const id = blockerDigest([request.project_id, request.task_id, request.payload.execution_id]);
    const jobId = blockerDigest([id, input.failure_at, ...["source_revision", "base_sha", "manifest_sha", "review_commit_sha"].map((field) => request.execution_context[field]), input.reason_code]);
    return store.withLock(STORE, async () => {
      const ledger = (await store.list(STORE)).find((entry) => entry.id === id)
        ?? { id, project_id: request.project_id, task_id: request.task_id, execution_id: request.payload.execution_id,
          calls: 0, resumes: 0, deadline_at: clock() + deadlineMs, policy: { max_calls: maxCalls, max_resumes: maxResumes }, jobs: [] };
      const existing = ledger.jobs.find((job) => job.id === jobId);
      if (existing || ledger.cancelled) return existing ?? null;
      const job = { ...structuredClone(input), id: jobId, stage: "sprint_leader", status: "pending", created_at: clock(), history: [] };
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
      ledger.cancelled = false;
      ledger.policy.max_calls = Math.max(ledger.policy.max_calls, ledger.calls + maxCalls);
      ledger.deadline_at = clock() + deadlineMs;
      job.status = "pending";
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
        if (!PENDING.includes(job.status) || ledger.cancelled) continue;
        if (job.status === "notifying") {
          if (clock() < job.notification_until) continue;
          job.status = "notification_pending";
        }
        if (!await validate(job)) { job.status = "cancelled"; job.outcome_reason = "stale_execution_or_source"; await store.save(STORE, ledger); continue; }
        if (["invoking", "dispatching"].includes(job.status)) {
          if (clock() < ledger.deadline_at) continue;
          job.outcome_reason = "provider_outcome_unknown"; job.status = "notification_pending";
        }
        if (job.status === "pending" && (ledger.calls >= ledger.policy.max_calls || clock() >= ledger.deadline_at)) {
          job.outcome_reason = "triage_budget_exhausted"; job.status = "notification_pending";
        }
        if (job.status === "resume_pending" && (ledger.resumes >= ledger.policy.max_resumes || clock() >= ledger.deadline_at)) {
          job.outcome_reason = "resume_budget_exhausted"; job.status = "notification_pending";
        }
        const operation = job.status;
        if (operation === "pending") { ledger.calls += 1; job.status = "invoking"; }
        if (operation === "resume_pending") { ledger.resumes += 1; job.status = "dispatching"; }
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
        return update(work, (current) => { current.status = current.resolution?.action === "owner_required" && current.stage === "architecture_manager" ? "owner_required" : "reconciliation_required"; });
      }
      if (operation === "resume_pending") {
        await checkDisposition(job.resolution, job);
        await resume(job);
        return update(work, (current) => { current.status = "resumed"; });
      }
      const response = await salvagePersistedAttempt(work, job) ?? await investigateAndRecord(work, job);
      if (!response) return null;
      const value = response[SALVAGED] ?? await checkDisposition(response, job);
      return update(work, (current) => {
        current.disposition_attempts.at(-1).status = "accepted";
        delete current.validation_feedback;
        delete current.last_error;
        current.history.push({ stage: current.stage, disposition: value, completed_at: clock() });
        if (value.action === "resolved") { current.resolution = value; current.status = "resume_pending"; }
        else if (current.stage === "sprint_leader") { current.stage = "architecture_manager"; current.status = "pending"; }
        else if (value.action === "owner_required") { current.resolution = value; current.status = "notification_pending"; current.outcome_reason = "authority_required"; }
        else { current.status = "notification_pending"; current.outcome_reason = "unresolved_after_architecture"; }
      });
    } catch (error) {
      if (!error.not_started) logger.error?.("Blocker recovery stage failed.", { task_id: job.request.task_id, stage: job.stage, code: error.code, error: error.message, validation_errors: error.validation_errors });
      return update(work, (current, ledger) => {
        if (error.not_started && operation === "pending") { current.status = "pending"; current.last_error = error.message; ledger.calls -= 1; }
        else {
          const feedback = error.validation_errors ?? [{ path: "/", reason: error.code ?? "BLOCKER_RECOVERY_FAILED", message: error.message }];
          if (operation === "pending") {
            current.disposition_attempts ??= [];
            if (error.response_evidence) current.disposition_attempts.push({ stage: current.stage, status: "received", received_at: clock(), response: error.response_evidence });
            const attempt = current.disposition_attempts.at(-1);
            if (attempt?.status === "received") Object.assign(attempt, { status: "rejected", validation_errors: feedback });
          }
          const correctable = operation === "pending" && error.code === "BLOCKER_DISPOSITION_INVALID" && error.retryable_disposition === true;
          const repairable = correctable
            && ledger.calls < ledger.policy.max_calls && clock() < ledger.deadline_at;
          current.status = repairable ? "pending" : "notification_pending";
          current.validation_feedback = feedback;
          if (!repairable) current.outcome_reason = correctable
            ? clock() >= ledger.deadline_at ? "disposition_correction_deadline_exhausted" : "disposition_correction_budget_exhausted"
            : error.code ?? "BLOCKER_RECOVERY_FAILED";
          current.last_error = error.message;
        }
      });
    }
  }

  // Reuses a persisted same-stage response that failed only envelope extraction (json_invalid with a single fenced JSON block), avoiding an unnecessary provider call.
  async function salvagePersistedAttempt(work, job) {
    const prior = (job.disposition_attempts ?? []).findLast((attempt) => attempt.stage === job.stage
      && attempt.status === "rejected" && attempt.validation_errors?.every((err) => err.reason === "json_invalid"));
    if (!prior?.response?.text) return null;
    const fences = [...String(prior.response.text).trim().matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map((match) => match[1].trim()).filter(Boolean);
    if (fences.length !== 1) return null;
    let verified;
    try { verified = await checkDisposition(JSON.parse(fences[0]), job); }
    catch (error) { return error && null; }
    const saved = await update(work, (current, ledger) => {
      ledger.calls = Math.max(0, ledger.calls - 1);
      const target = (current.disposition_attempts ?? []).findLast((attempt) => attempt.stage === current.stage && attempt.status === "rejected");
      if (target) { target.status = "received"; delete target.validation_errors; }
    });
    return saved ? { [SALVAGED]: verified } : null;
  }

  // Invokes the stage provider and records its raw response evidence before disposition validation.
  async function investigateAndRecord(work, job) {
    const response = await investigate(job, { deadline: work.deadline });
    const saved = await update(work, (current) => {
      current.disposition_attempts ??= [];
      current.disposition_attempts.push({ stage: current.stage, status: "received", received_at: clock(), response: blockerResponseEvidence(response) });
    });
    return saved ? response : null;
  }

  // Writes results only for the stage that still owns the persisted invocation reservation.
  async function update(work, change) {
    return store.withLock(STORE, async () => {
      const ledger = (await store.list(STORE)).find((entry) => entry.id === work.ledgerId);
      const job = ledger.jobs.find((entry) => entry.id === work.job.id);
      if (ledger.cancelled || job.status !== work.job.status || job.stage !== work.job.stage) return null;
      change(job, ledger);
      await store.save(STORE, ledger);
      return job;
    });
  }

  // Starts a serialized local poller; persisted stage claims coordinate other processes.
  async function start() { if (active) return; active = true; void poll(); }

  // Stops local polling without clearing durable work or resetting its budget.
  function stop() { active = false; clearTimeout(timer); }

  // Reports adapter failures and keeps pending work observable instead of silently dropping it.
  async function poll() {
    try { await tick(); } catch (error) { logger.error?.("Blocker recovery poll failed.", error); }
    finally { if (active) { timer = setTimeout(poll, 1000); timer.unref?.(); } }
  }
}
