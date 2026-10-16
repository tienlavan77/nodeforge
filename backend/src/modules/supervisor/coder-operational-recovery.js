// Persists bounded Coder operational retries separately from Reviewer and source repair budgets.
import { createHash, randomUUID } from "node:crypto";
import { validExecutionBasis } from "../projects/ticket-execution-identity.js";
import { classifyCoderFailure } from "./coder-failure-routing.js";

const STORE = "coder-operational-recovery";

// Builds a disabled-unless-configured recovery ledger with explicit execution fencing and dispatch ownership.
export function createCoderOperationalRecovery({ store, policy, validateExecution, dispatch, publishTerminal, clock = Date.now, logger = console } = {}) {
  if (!store?.withLock || !store.list || !store.save) throw new Error("Coder recovery requires an interprocess-locked durable store.");
  if (policy && (!policy.policy_id || !Number.isSafeInteger(policy.max_retries) || policy.max_retries < 1
    || !Number.isSafeInteger(policy.deadline_ms) || policy.deadline_ms < 30_000
    || ![validateExecution, dispatch, publishTerminal].every((callback) => typeof callback === "function"))) throw new Error("Coder recovery requires an approved finite policy and fenced dispatch/terminal callbacks.");
  const approvedPolicy = policy ? structuredClone(policy) : null;
  let timer;
  let active = false;
  return Object.freeze({ handleFailure, tick, cancel, start, stop, hasPending });

  // Keeps explicit RUN from replacing an execution whose recovery or provider disposition is still outstanding.
  async function hasPending({ projectId, taskId, executionId }) {
    return (await store.list(STORE)).some((ledger) => ledger.project_id === projectId && ledger.task_id === taskId
      && ledger.execution_id === executionId && !ledger.cancelled && ledger.failures.some((record) =>
        ["pending", "invoking", "terminal_pending", "reconciliation_required"].includes(record.status)));
  }

  // Polls the durable ledger after startup without resetting deadlines or reclaiming unknown invocations.
  async function start() {
    if (active || !approvedPolicy) return;
    active = true;
    await poll();
  }

  // Stops local polling; task cancellation is a separate, execution-bound durable operation.
  function stop() { active = false; clearTimeout(timer); }

  // Serializes local polling and reports storage or dispatch faults instead of swallowing them.
  async function poll() {
    try { await tick(); }
    catch (error) { logger.error("Coder recovery requires reconciliation:", error); }
    finally { if (active) { timer = setTimeout(poll, 1000); timer.unref?.(); } }
  }

  // Deduplicates both failure routes by invocation, reserving budget and a child request before dispatch.
  async function handleFailure({ request, error, source }) {
    if (!approvedPolicy) return { handled: false, reason: "coder_recovery_unconfigured" };
    const basis = request?.payload?.sprint_basis;
    const executionId = request?.payload?.execution_id;
    const revision = request?.execution_context?.source_revision ?? request?.payload?.execution_context?.source_revision;
    if (!request?.project_id || !request.task_id || !request.request_id || !executionId || !revision
      || !validExecutionBasis(basis) || basis.project_id !== request.project_id) return { handled: false, reason: "recovery_identity_missing" };
    const id = digest([request.project_id, request.task_id, executionId, "coder"]);
    return store.withLock(STORE, async () => {
      const ledger = (await store.list(STORE)).find((entry) => entry.id === id);
      const previous = ledger?.failures.find((entry) => entry.parent_request_id === request.request_id);
      const classification = classifyCoderFailure(error);
      if (previous && ["reconcile", "authority"].includes(classification)) {
        if (previous.status === "pending") {
          previous.status = classification === "reconcile" ? "reconciliation_required" : "cancelled";
          previous.conflicting_failure_code = error.code;
          await store.save(STORE, ledger);
        }
        return { handled: classification === "reconcile", outcome: previous.status, record: previous };
      }
      if (previous) return { handled: true, outcome: previous.status, record: previous };
      if (!await validateExecution(request)) return { handled: true, outcome: "stale" };
      if (ledger?.cancelled) return { handled: true, outcome: "cancelled" };
      if (classification !== "transient") return { handled: false, reason: classification };
      const now = clock();
      const next = ledger ?? { id, project_id: request.project_id, task_id: request.task_id, execution_id: executionId,
        policy: approvedPolicy, deadline_at: now + approvedPolicy.deadline_ms, retries: 0, failures: [] };
      const exhausted = next.retries >= next.policy.max_retries || now + 30_000 >= next.deadline_at;
      const record = { failure_id: digest([id, request.request_id]), parent_request_id: request.request_id,
        child_request_id: `REQ-RETRY-${randomUUID()}`, confirmed_failure_at: now, available_at: now + 30_000,
        source_revision: revision, source, phase: "coder_operational_retry", request: structuredClone(request), cause_code: error.cause?.code ?? error.code,
        retry_ordinal: exhausted ? null : next.retries + 1, status: exhausted ? "terminal_pending" : "pending" };
      if (!exhausted) next.retries += 1;
      next.failures.push(record);
      await store.save(STORE, next);
      return { handled: true, outcome: record.status, record };
    });
  }

  // Dispatches at most one due retry per tick; a persisted invoking state is never lease-reclaimed.
  async function tick() {
    if (!approvedPolicy) return null;
    const work = await store.withLock(STORE, async () => {
      for (const ledger of await store.list(STORE)) {
        for (const record of ledger.failures) {
          if (!["pending", "terminal_pending"].includes(record.status)) continue;
          if (ledger.cancelled || !await validateExecution(record.request)) {
            record.status = "cancelled";
            await store.save(STORE, ledger);
            continue;
          }
          if (record.status === "pending" && clock() >= ledger.deadline_at) record.status = "terminal_pending";
          if (record.status === "pending" && clock() < record.available_at) continue;
          const terminal = record.status === "terminal_pending";
          record.status = terminal ? "terminal_pending" : "invoking";
          await store.save(STORE, ledger);
          return { ledgerId: ledger.id, record: structuredClone(record), terminal };
        }
      }
      return null;
    });
    if (!work) return null;
    const { record, ledgerId, terminal } = work;
    try {
      if (terminal) await publishTerminal({ request: record.request, event_id: `CODER-RECOVERY-${record.failure_id}`, reason: "CODER_RECOVERY_EXHAUSTED" });
      else await dispatch({ ...record.request, request_id: record.child_request_id,
        payload: { ...record.request.payload, operational_retry: { parent_request_id: record.parent_request_id, failure_id: record.failure_id, ordinal: record.retry_ordinal } } }, { source: record.source });
      await update(ledgerId, record.failure_id, terminal ? "terminal" : "dispatched");
    } catch (error) {
      await update(ledgerId, record.failure_id, terminal ? "terminal_pending" : "reconciliation_required", error.code ?? "RECOVERY_DISPATCH_UNKNOWN");
      throw error;
    }
    return record;
  }

  // Invalidates pending retries without relinquishing unknown or already running provider invocations.
  async function cancel({ projectId, taskId, executionId }) {
    return store.withLock(STORE, async () => {
      const ledgers = await store.list(STORE);
      if (!ledgers.some((ledger) => ledger.project_id === projectId && ledger.task_id === taskId && ledger.execution_id === executionId)) {
        await store.save(STORE, { id: digest([projectId, taskId, executionId, "coder"]), project_id: projectId, task_id: taskId, execution_id: executionId, cancelled: true, failures: [] });
      }
      for (const ledger of ledgers) {
        if (ledger.project_id !== projectId || ledger.task_id !== taskId || ledger.execution_id !== executionId) continue;
        ledger.cancelled = true;
        for (const record of ledger.failures) if (["pending", "terminal_pending"].includes(record.status)) record.status = "cancelled";
        await store.save(STORE, ledger);
      }
    });
  }

  // Records dispatch disposition without overwriting a concurrent failure scheduled by the child invocation.
  async function update(ledgerId, failureId, status, errorCode) {
    await store.withLock(STORE, async () => {
      const ledger = (await store.list(STORE)).find((entry) => entry.id === ledgerId);
      const record = ledger.failures.find((entry) => entry.failure_id === failureId);
      record.status = status;
      if (errorCode) record.error_code = errorCode;
      await store.save(STORE, ledger);
    });
  }
}

// Generates stable execution and failure identities without unsafe path fragments.
function digest(parts) { return createHash("sha256").update(JSON.stringify(parts)).digest("hex"); }
