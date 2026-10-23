// Coordinates durable automatic review jobs, attempt recovery, and immutable post-completion follow-up backlog.
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { retryOperationalReview, recoverOperationalReview } from "./review-operational-retry.js";
import { recordAutomaticReviewFindings } from "./automatic-review-findings.js";
import { ConfigurationError } from "../../shared/errors.js";
import { automaticReviewIdentity, automaticReviewPolicy, bindAutomaticReviewCycle, matchesAutomaticReviewContext, reviewDigest } from "./automatic-review-identity.js";
import { assertReviewRequestOwnership, assertCachedReviewResult, reviewRequestBasis } from "./recovery-evidence.js";
import { acquireTicketFileLock } from "./ticket-file-lock.js";
import { finalizeCoderWorkspace } from "./ticket-coder-completion.js";
import { publishAutomaticReviewOutcome, publishAutomaticReviewParking } from "./automatic-review-audit.js";
import { isCompletedReviewReopened } from "./completed-review-resume.js";
import { reviewOperationalFailure } from "./review-operational-failure.js";
import { beginAutomaticReview } from "./automatic-review-stage.js";
import { reconcileReviewRepairAuthority, reviewRepairScopeConflict } from "./review-repair-authority.js";

const QUEUE = "agent.request";
const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });
// Stores one logical review per complete identity and never treats infrastructure outcomes as approval.
export function createAutomaticTicketReview({ queueStore, queue, eventBus, fileService, resolveTicketWorkspace, resolveWorker, ticketStatusStore, checkpoints, agentOccupancy, resumeRepair, operationalRetry = true, retryClock, retryWait, projectLogger = () => {} }) {
  const active = new Map(); const recovering = new Set();
  return Object.freeze({ prepare, dispatch, process, retry, recover, park, consumeRepair, recordCompletion, publishCompletion, findJob, assertApproval, skip });

  // Persists the source snapshot and deferred dispatch before ticket integration can release its evidence.
  async function prepare({ request, artifact, workspace, inline = true }) {
    const contractDecisions = (await checkpoints?.load?.(request.task_id))?.contract_decisions ?? [];
    const context = await workspace.executionContexts.load(request.task_id);
    request = bindAutomaticReviewCycle(request, context);
    const policy = automaticReviewPolicy(request.ticket, { blocking: Boolean(request.payload?.review_cycle_id) });
    let rules = "";
    let rulesError = null;
    try { rules = (await fileService.readForIndex({ path: "workflows/agents/reviewer/README.md", maxBytes: 32_000 })).content ?? ""; }
    catch (error) { rulesError = { code: error.code ?? "REVIEWER_RULES_UNAVAILABLE", message: error.message }; }
    let exchange = {};
    let exchangeError = null;
    try { exchange = await workspace.reviewFindings.load(); }
    catch (error) { exchangeError = { code: error.code ?? "REVIEW_FINDINGS_UNAVAILABLE", message: error.message }; }
    const { identity, job_key: jobKey } = automaticReviewIdentity({ request, artifact, context, policy, rules, exchange });
    const prepared = await locked(async () => {
      const jobs = await queueStore.list(QUEUE);
      const existing = jobs.find((job) => job.automatic_review && job.job_key === jobKey);
      if (existing) { assertReviewRequestOwnership(existing, ticketStatusStore); return existing; }
      const history = jobs.filter((job) => job.automatic_review && job.task_id === request.task_id && job.payload?.review_cycle_id === request.payload?.review_cycle_id);
      if (history.some((job) => job.review_policy.gate !== policy.gate)) throw fail("REVIEW_POLICY_CONFLICT", "Review gate cannot change during ticket execution.");
      const suffix = jobKey.slice(7);
      const job = { id: `JOB-REVIEW-${suffix}`, request_id: `REVIEW-${suffix}`, queue: QUEUE, operation: "review", role: "reviewer", automatic_review: true,
        job_key: jobKey, decision_identity: identity, review_policy: policy, review_rules: rules, rules_error: rulesError, exchange_error: exchangeError, inline_review: inline,
        task_id: request.task_id, project_id: request.project_id, supervisor_id: request.supervisor_id ?? `SUP-${request.task_id}`,
        correlation_id: request.correlation_id, agent_id: request.agent_id, attempt: request.attempt ?? 1, status: "deferred", attempts: 0,
        source_request: structuredClone(request), finding_snapshot: exchange, outcomes: [],
        payload: { ...request.payload, ticket: request.ticket, execution_context: context, verification: artifact, commit: artifact.commit_sha,
          base_commit: artifact.base_sha, changed_paths: artifact.changed_paths, contract_decisions: contractDecisions }, created_at: new Date().toISOString() };
      assertReviewRequestOwnership(job, ticketStatusStore);
      await queueStore.save(QUEUE, job);
      return job;
    });
    return policy.gate === "on" && request.payload?.review_resume && prepared.review_result && !prepared.review_result.payload.verdict && !(operationalRetry && prepared.review_result.payload.error?.retryable) ? retry(prepared) : prepared;
  }

  // Activates only post-completion soft review, or an explicitly queued hard-gate review.
  async function dispatch(job) {
    if (job.review_policy.gate === "off") {
      const workspace = await resolveTicketWorkspace(job.task_id);
      const context = await workspace.executionContexts.load(job.task_id);
      if (context?.state !== "terminal" || !matchesAutomaticReviewContext(context, job)) throw fail("REVIEW_COMPLETION_PENDING", "Soft review cannot dispatch before exact completion.");
    }
    await locked(async () => { const current = await load(job.id); if (current.status === "deferred") await queueStore.save(QUEUE, { ...current, status: "queued" }); });
    await queue.enqueue({ ...job, request_id: job.request_id });
  }

  // Serializes same-process delivery and reuses a persisted decision instead of invoking the provider again.
  async function process(job) {
    if (active.has(job.id)) return active.get(job.id);
    const promise = processLocked(job);
    active.set(job.id, promise);
    try { return await promise; } finally { active.delete(job.id); }
  }

  // Holds a distinct job lock during provider execution so separate workers cannot review the same attempt concurrently.
  async function processLocked(job) {
    const lock = fileService.createLock ? await acquireTicketFileLock(fileService, `${statePath()}/automatic-review-locks/${job.id}.lock`) : null;
    try { return await (operationalRetry ? retryOperationalReview({ job, attempt: processOnce, retry, load, save: (next) => queueStore.save(QUEUE, next), locked, ticketStatusStore, resolveTicketWorkspace, checkpoints, eventBus, projectLogger, clock: retryClock, wait: retryWait }) : processOnce(job)); } finally { await lock?.release(); }
  }

  // Writes the complete outcome and event intent before event publication or queue acknowledgement.
  async function processOnce(job) {
    let current = await reconcileRepairAuthority(await load(job.id));
    assertReviewRequestOwnership(current, ticketStatusStore);
    if (current.review_result) { assertCachedReviewResult(current); if (!operationalRetry || !current.review_result.payload.error?.retryable) await publish(current); return current.review_result; }
    let result;
    try {
      if (current.running_attempt) throw fail("REVIEW_PROVIDER_OUTCOME_UNKNOWN", "Interrupted provider invocation requires an audited operational retry.");
      current = await locked(async () => { const fresh = await load(job.id); const next = { ...fresh, running_attempt: `${fresh.request_id}-OP-${fresh.outcomes.length + 1}` }; await queueStore.save(QUEUE, next); return next; });
      await beginAutomaticReview(current, ticketStatusStore, checkpoints);
      if (current.rules_error || !current.review_rules) throw fail("REVIEWER_RULES_UNAVAILABLE", current.rules_error?.message ?? "Reviewer rules are missing.");
      if (current.exchange_error) throw fail("REVIEW_FINDINGS_UNAVAILABLE", current.exchange_error.message);
      if (current.review_policy.gate === "off") { const context = await (await resolveTicketWorkspace(current.task_id)).executionContexts.load(current.task_id); if (context?.state !== "terminal" || !matchesAutomaticReviewContext(context, current)) throw fail("REVIEW_COMPLETION_PENDING", "Soft review requires the exact completed integration."); }
      const worker = await resolveWorker(current);
      if (!worker) throw fail("REVIEW_WORKER_UNAVAILABLE", "Reviewer worker is unavailable.");
      const payload = await worker.review(current);
      assertReviewRequestOwnership(current, ticketStatusStore);
      if (!["approved", "request_changes"].includes(payload?.verdict) || !payload.reviewer_id || payload.reviewer_id === current.agent_id || payload.source_revision !== current.decision_identity.source_revision || !Array.isArray(payload.findings)
        || !Array.isArray(payload.adjudications ?? []) || payload.verdict === "request_changes" && !payload.findings.length && !(payload.adjudications ?? []).some((decision) => ["retain", "refine", "reopen"].includes(decision.decision))) throw fail("REVIEW_VERDICT_INVALID", "Reviewer verdict does not match the independent source revision or finding contract.");
      await recordAutomaticReviewFindings({ job: current, workspace: await resolveTicketWorkspace(current.task_id), payload });
      result = { type: payload.verdict === "approved" ? "review.approved" : "review.request_changes", payload };
      if (payload.verdict === "request_changes" && reviewRepairScopeConflict(payload.findings, current.payload.execution_context)) result.payload.owner_decision_reason = "review_scope_conflict";
    } catch (error) {
      if (error.code === "EXECUTION_RECONCILIATION_CONFLICT") throw error;
      const unavailable = ["REVIEWER_NOT_AVAILABLE", "REVIEW_WORKER_UNAVAILABLE", "REVIEWER_PROVIDER_UNAVAILABLE"].includes(error.code);
      result = { type: unavailable ? "review.unavailable" : "review.failed", payload: { outcome_label: unavailable ? "review_unavailable" : "review_failed", error: reviewOperationalFailure(error) ?? { code: error.code ?? "REVIEW_FAILED", message: error.message } } };
      projectLogger({ event_name: "review.automatic_failed", level: "error", status: "failed", message: error.message, task_id: current.task_id, source: "automatic-review", error_code: result.payload.error.code });
    }
    current = await locked(async () => {
      const fresh = await load(job.id);
      if (reviewDigest(reviewRequestBasis(fresh)) !== reviewDigest(reviewRequestBasis(current))) throw fail("EXECUTION_RECONCILIATION_CONFLICT", "Review source identity changed before outcome persistence.");
      if (fresh.review_result) return fresh;
      const attemptId = `${current.request_id}-OP-${(fresh.outcomes?.length ?? 0) + 1}`;
      const eventId = `EVT-${attemptId}`;
      const outcome = { job_key: current.job_key, attempt_id: attemptId, event_id: eventId, outcome_label: result.payload.outcome_label ?? result.payload.verdict,
        reason_code: result.payload.error?.code ?? result.type, source_revision: current.decision_identity.source_revision, created_at: new Date().toISOString() };
      const payload = { ...result.payload, automatic_review: true, job_key: current.job_key, decision_identity: current.decision_identity, review_gate: current.review_policy.gate, inline_review: current.inline_review,
        execution_id: current.source_request.payload?.execution_id, execution_basis: current.source_request.payload?.sprint_basis };
      const next = { ...fresh, review_result: { ...result, payload, basis: reviewRequestBasis(fresh) }, outcomes: [...(fresh.outcomes ?? []), outcome], event_id: eventId, running_attempt: null };
      await queueStore.save(QUEUE, next);
      return next;
    });
    if (!operationalRetry || !current.review_result.payload.error?.retryable) await publish(current);
    return current.review_result;
  }

  // Replays a stable review event and materializes deduplicated follow-up tickets without changing the completed ticket.
  async function publish(job) {
    job = await reconcileRepairAuthority(job);
    assertReviewRequestOwnership(job, ticketStatusStore);
    assertCachedReviewResult(job);
    await publishAutomaticReviewOutcome({ job, queueStore, queue, eventBus, checkpoints, repairCount, locked });
  }

  // Records bounded operational recovery as a new attempt on the same logical decision identity.
  async function retry(job) {
    return locked(async () => {
      const current = await load(job.id);
      if (current.running_attempt) throw fail("REVIEW_ATTEMPT_ACTIVE", "Reconcile the interrupted review attempt before requesting retry.");
      if (current.review_result?.payload.verdict) return current;
      if ((current.outcomes?.length ?? 0) >= current.review_policy.max_operational_attempts && !current.review_result?.payload.error?.retryable) throw fail("REVIEW_RETRY_LIMIT", "Operational review retry budget exhausted.");
      const next = { ...current, review_result: null, status: "deferred", event_id: null, parking_outcome: null };
      await queueStore.save(QUEUE, next);
      return next;
    });
  }

  // Records each finding-driven repair once per decision without limiting revision count.
  async function consumeRepair(job) {
    return locked(async () => {
      const current = await load(job.id);
      if (current.repair_consumed) return true;
      await queueStore.save(QUEUE, { ...current, repair_consumed: true });
      return true;
    });
  }

  // Parks only a hard-gate ticket and writes a separate revision-limit audit without inventing approval.
  async function park(job, reason) {
    if (job.review_policy.gate !== "on") throw fail("REVIEW_SOFT_PARK_FORBIDDEN", "Soft review cannot park a completed ticket.");
    assertReviewRequestOwnership(job, ticketStatusStore);
    const current = await load(job.id);
    if (ticketStatusStore?.get?.(job.task_id)?.details?.reason === "TICKET_STOPPED") return { status: "failed", reason: "TICKET_STOPPED" };
    if (current.review_result?.payload.error?.retryable) projectLogger({ event_name: "review.retry_available", level: "warn", status: "failed", task_id: job.task_id, message: "Reviewer gặp lỗi kết nối tạm thời. Ticket có thể Resume đúng bước review với commit/artifact đã giữ; không cần duyệt thủ công.", error_code: reason });
    return publishAutomaticReviewParking({ job: current, reason, queueStore, eventBus, locked, load });
  }

  // Persists completion event intent before publication so a crash cannot lose asynchronous review dispatch.
  async function recordCompletion(job, payload) {
    await locked(async () => { const current = await load(job.id); await queueStore.save(QUEUE, { ...current, completion_intent: { type: "task.completed", event_id: `EVT-COMPLETE-${job.request_id}`,
      task_id: job.task_id, supervisor_id: job.supervisor_id, project_id: job.project_id, request_id: job.source_request.request_id,
      correlation_id: job.correlation_id, attempt: job.attempt, payload: { ...payload, execution_id: job.source_request.payload?.execution_id, execution_basis: job.source_request.payload?.sprint_basis } } }); });
  }

  // Publishes the separately persisted completion intent with its own identity, never reusing a review event ID.
  async function publishCompletion(job) { const current = await load(job.id); if (isCompletedReviewReopened(current, ticketStatusStore)) return; const context = await (await resolveTicketWorkspace(job.task_id)).executionContexts.load(job.task_id); if (!current.completion_intent || context?.state !== "terminal" || !matchesAutomaticReviewContext(context, current)) throw fail("REVIEW_COMPLETION_PENDING", "Exact terminal completion intent is required."); await eventBus.publish(current.completion_intent); }

  // Audits an explicit soft-gate skip without fabricating a verdict or reopening the completed ticket.
  async function skip(job, reason) {
    if (job.review_policy.gate !== "off" || !reason?.trim()) throw fail("REVIEW_SKIP_FORBIDDEN", "Only an audited soft review may be skipped.");
    const context = await (await resolveTicketWorkspace(job.task_id)).executionContexts.load(job.task_id);
    if (context?.state !== "terminal" || !matchesAutomaticReviewContext(context, job)) throw fail("REVIEW_SKIP_FORBIDDEN", "Skip must reference the completed revision.");
    const current = await locked(async () => {
      const fresh = await load(job.id);
      if (fresh.review_result) return fresh;
      const eventId = `EVT-SKIP-${job.request_id}`;
      const next = { ...fresh, event_id: eventId, review_result: { type: "review.skipped", payload: { outcome_label: "review_skipped", reason_code: reason }, basis: reviewRequestBasis(fresh) },
        outcomes: [...fresh.outcomes, { job_key: job.job_key, attempt_id: `SKIP-${job.request_id}`, outcome_label: "review_skipped", reason_code: reason, source_revision: job.decision_identity.source_revision, event_id: eventId, created_at: new Date().toISOString() }] };
      await queueStore.save(QUEUE, next); return next;
    });
    await publish(current);
  }

  // Recovers deferred post-integration jobs without invoking the Coder or reopening terminal ticket contexts.
  async function recover() {
    for (let job of await queueStore.list(QUEUE)) {
      if (!job.automatic_review || isCompletedReviewReopened(job, ticketStatusStore)) continue;
      try {
        assertReviewRequestOwnership(job, ticketStatusStore);
        assertCachedReviewResult(job);
        const workspace = await resolveTicketWorkspace(job.task_id);
        const context = await workspace.executionContexts.load(job.task_id);
        if (!matchesAutomaticReviewContext(context, job)) continue;
        job = await reconcileRepairAuthority(job);
        if (operationalRetry && job.review_result?.payload.error?.retryable && job.operational_retry?.status !== "cancelled") { if (active.has(job.id) || recovering.has(job.id)) continue; recovering.add(job.id); void recoverOperationalReview({ job, checkpoints, resumeReview: resumeRepair, process, recover }).catch(error => projectLogger({ event_name: "review.retry_recovery_failed", level: "error", status: "failed", task_id: job.task_id, message: error.message, error_code: error.code })).finally(() => recovering.delete(job.id)); continue; }
        if (job.running_attempt && !job.review_result) {
          const outcome = await process(job);
          if (job.inline_review && job.review_policy.gate === "on") await park(job, outcome.payload.error.code);
          continue;
        }
        if (job.parking_outcome && job.review_result?.payload.verdict !== "approved") await park(job, job.parking_outcome.reason_code);
        if (job.review_policy.gate === "on" && job.inline_review && job.review_result?.payload.verdict === "approved" && context?.state !== "terminal") {
          await assertApproval({ ...job.review_result.payload, job_key: job.job_key, decision_identity: job.decision_identity });
          await recordCompletion(job, { completion: "reviewed", artifact_id: job.payload.verification.artifact_id, commit_sha: job.payload.verification.commit_sha });
          await finalizeCoderWorkspace(workspace, job.task_id, { reviewed: true });
        }
        const current = await load(job.id);
        if (current.completion_intent && !isCompletedReviewReopened(current, ticketStatusStore) && (await workspace.executionContexts.load(job.task_id))?.state === "terminal" && matchesAutomaticReviewContext(await workspace.executionContexts.load(job.task_id), current)) await eventBus.publish(current.completion_intent);
        if ((await workspace.executionContexts.load(job.task_id))?.state === "terminal") { const claim = agentOccupancy?.getByTask?.(job.task_id); if (claim?.supervisor_id === job.supervisor_id) await agentOccupancy.release({ claimId: claim.claim_id, taskId: job.task_id, supervisorId: job.supervisor_id, reason: "automatic_review_completion_recovered" }); }
        if (job.review_result) { await publish(job); continue; }
        if (job.review_policy.gate === "off" && job.status === "deferred") {
          if ((await workspace.executionContexts.load(job.task_id))?.state === "terminal") await dispatch(job);
        }
      } catch (error) {
        projectLogger({ event_name: "review.recovery_failed", level: "error", status: "blocked", message: error.message, task_id: job.task_id, source: "automatic-review", error_code: error.code });
      }
    }
  }

  // Persists the corrected Node routing once under the queue lock without invoking Reviewer or altering its verdict.
  async function reconcileRepairAuthority(job) {
    if (job.review_result?.payload.owner_decision_reason !== "review_blocker") return job;
    return locked(async () => {
      const current = await load(job.id);
      assertReviewRequestOwnership(current, ticketStatusStore);
      const next = reconcileReviewRepairAuthority(current);
      if (next !== current) await queueStore.save(QUEUE, next);
      return next;
    });
  }

  // Loads the durable job rather than trusting stale delivery snapshots.
  async function load(id) { const job = (await queueStore.list(QUEUE)).find((entry) => entry.id === id); if (!job) throw fail("REVIEW_JOB_MISSING", "Automatic review job is missing."); return job; }
  // Finds the logical review named by an event without accepting an arbitrary approval payload.
  async function findJob(key) { const job = (await queueStore.list(QUEUE)).find((entry) => entry.automatic_review && entry.job_key === key); if (!job) throw fail("REVIEW_JOB_MISSING", "Review event identity is unknown."); return job; }
  // Rechecks artifact and findings at the final acceptance boundary, not only when the Reviewer returned.
  async function assertApproval(payload) {
    const job = await findJob(payload.job_key);
    assertReviewRequestOwnership(job, ticketStatusStore);
    assertCachedReviewResult(job);
    if (job.review_result?.payload.verdict !== "approved" || reviewDigest(payload.decision_identity) !== reviewDigest(job.decision_identity)) throw fail("REVIEW_EVIDENCE_MISMATCH", "Approval event differs from its durable decision.");
    const workspace = await resolveTicketWorkspace(job.task_id);
    const current = automaticReviewIdentity({ request: job.source_request, artifact: await workspace.testService.assertPassedArtifact(), context: await workspace.executionContexts.load(job.task_id), policy: job.review_policy, rules: job.review_rules, exchange: await workspace.reviewFindings.load() });
    if (current.job_key !== job.job_key) throw fail("REVIEW_EVIDENCE_MISMATCH", "Approval artifact is stale.");
    await workspace.reviewFindings.assertResolved();
  }
  // Counts persisted repair decisions across all revisions and policy identities for this ticket.
  async function repairCount(taskId) { return [...await queueStore.list(QUEUE), ...await queueStore.list("review.repair")].filter((job) => (job.automatic_review || job.queue === "review.repair" || job.source_job_id) && job.task_id === taskId && job.repair_consumed).length; }
  // Uses the queue's cross-process lock for logical-job uniqueness and append-only outcome writes.
  async function locked(operation) { return queueStore.withLock ? queueStore.withLock(QUEUE, operation, "automatic_review") : operation(); }
}
