// Business purpose: preserves AM-SE-RV handoff progress independently of individual SDK turns.
// Technical description: enforces guarded intent/result transitions, immutable execution plan identity, and fail-closed resume decisions.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";
import { handoffWorkspaceSnapshot } from "./am-se-handoff-workspace.js";

// Business purpose: reports a bounded handoff safety failure without leaking prompts or workspace content.
// Technical description: attaches a stable code and conflict status to a configuration error.
function fail(code) { throw Object.assign(new ConfigurationError(code), { code, statusCode: 409 }); }

// Business purpose: runs and resumes one checkpointed handoff step at a time.
// Technical description: uses the store's locked generation transition and a per-attempt fence to prevent duplicate or stale completions.
export function createAmSeHandoffCheckpoint({ store, markdownPlanStore, fileService, gitService, projectId, executionCheckpoint, onEvent } = {}) {
  if (!store?.transition || !markdownPlanStore?.assertApproved || !fileService?.readFile || !gitService?.status || !gitService?.getHead) fail("HANDOFF_CHECKPOINT_UNAVAILABLE");
  const now = () => new Date().toISOString();
  const workspace = async () => handoffWorkspaceSnapshot({ projectId, gitService, fileService });
  const same = (a, b) => Boolean(a?.fingerprint && a.project_id === b?.project_id && a.head === b?.head && a.fingerprint === b?.fingerprint);
  const log = (record, transition, code = null) => onEvent?.({ handoff_id: record.handoff_id, round: record.checkpoint?.round, step: record.checkpoint?.current_step, execution_id: record.checkpoint?.execution_id, attempt: record.checkpoint?.attempt, transition, error_code: code });
  const identity = (record) => ({ planId: record.plan_id, revision: record.plan_revision, sha256: record.plan_sha256 });

  // Business purpose: verifies an approved, unchanged plan before executing another role.
  // Technical description: compares the persisted revision and SHA with the plan registry and immutable source bytes.
  async function verifyPlan(record) {
    const approved = await markdownPlanStore.assertApproved(identity(record));
    if (approved.source_path !== record.plan_source_path || approved.project_id && approved.project_id !== projectId) fail("HANDOFF_PLAN_MISMATCH");
    await fileService.readFile({ path: record.plan_source_path });
    return approved;
  }

  // Business purpose: creates the execution checkpoint only after critique and valid approval.
  // Technical description: pins plan and baseline workspace to the existing handoff record without changing its ID.
  async function initialize(handoffId, approvedOwnerId = "legacy-test-owner") {
    const record = await store.get(handoffId);
    if (!record || record.project_id !== projectId || record.phase !== "implementation" || record.status !== "running" || record.round !== 1 || record.checkpoint && !record.checkpoint.approval_pending || typeof approvedOwnerId !== "string" || !approvedOwnerId) fail("HANDOFF_INITIALIZATION_INVALID");
    await verifyPlan(record);
    const baseline = await workspace();
    return store.transition(handoffId, record.checkpoint?.generation ?? 0, (current) => {
      if (current.checkpoint && !current.checkpoint.approval_pending || current.phase !== "implementation" || current.status !== "running" || current.round !== 1 || current.plan_revision !== record.plan_revision || current.plan_sha256 !== record.plan_sha256 || current.plan_source_path !== record.plan_source_path) fail("HANDOFF_STALE");
      return { ...current, checkpoint: { generation: current.checkpoint?.generation ?? 0, plan_locked: true, approved_owner_id: approvedOwnerId, workspace: baseline, round: 1, current_step: null, next_step: "se", execution_status: "pending", results: [], attempt: 0, updated_at: now() } };
    });
  }

  // Business purpose: accepts only a fenced SDK result for the exact interrupted or live handoff attempt.
  // Technical description: validates terminal identity, provider result evidence and reviewer read-only enforcement before advancing the durable state machine.
  async function complete(handoffId, intent, result) {
    const cp = intent.checkpoint;
    const step = cp.current_step;
    const text = typeof result?.text === "string" ? result.text.trim() : "";
    const verdict = result?.verdict;
    const evidence = result?.result_evidence;
    const valid = Boolean(text && result?.execution_id === cp.execution_id && result?.terminal_status === "completed" && evidence?.sdk_status === "completed" && evidence?.turn_completed !== false && (step !== "rv" || result?.read_only_enforced === true) && (step === "se" || ["PASS", "REVISE"].includes(verdict)));
    let observed;
    try { observed = await workspace(); } catch (error) { observed = null; log(intent, "workspace_unknown", error?.code ?? "HANDOFF_WORKSPACE_UNKNOWN"); }
    const completed = await store.transition(handoffId, cp.generation, (current) => {
      if (current.checkpoint.execution_id !== cp.execution_id || current.checkpoint.execution_status !== "running" || current.checkpoint.current_step !== step) fail("HANDOFF_STALE");
      const accepted = valid && Boolean(observed) && (step === "se" || same(current.checkpoint.workspace, observed));
      const acceptedFinal = accepted && step === "am" && verdict === "PASS";
      const next = !accepted || acceptedFinal ? null : step === "se" ? "rv" : step === "rv" && verdict === "PASS" ? "am" : "se";
      const nextRound = accepted && next === "se" ? cp.round + 1 : cp.round;
      const status = acceptedFinal ? "completed" : accepted ? next === "se" && nextRound > current.max_rounds ? "blocked" : "pending" : step === "se" ? "reconciliation_required" : "blocked";
      const entry = accepted ? { round: cp.round, step, execution_id: cp.execution_id, attempt: cp.attempt, text, ...(step !== "se" ? { verdict } : {}), result_evidence: evidence, completed_at: now() } : null;
      return { ...current, status: status === "completed" ? "completed" : status === "blocked" ? "paused" : "running", round: nextRound, checkpoint: { ...current.checkpoint, workspace: accepted ? observed : current.checkpoint.workspace, round: nextRound, current_step: status === "pending" || status === "completed" ? null : step, next_step: status === "pending" ? next : null, execution_status: status, results: entry ? [...current.checkpoint.results, entry] : current.checkpoint.results, error_code: accepted ? null : "HANDOFF_RESULT_REQUIRED", updated_at: now() } };
    });
    log(completed, completed.checkpoint.error_code ? "result_missing" : "result", completed.checkpoint.error_code);
    return completed;
  }

  // Business purpose: refuses to reuse a possibly mutating interrupted execution without reconciliation.
  // Technical description: checks runner stop, pending tool receipts and baseline; uncertainty always requires an operator.
  async function reconcile(handoffId, { operatorApproved = false } = {}) {
    const record = await store.get(handoffId);
    const cp = record?.checkpoint;
    if (!cp || record.project_id !== projectId || !["running", "reconciliation_required", "unknown"].includes(cp.execution_status) || !["se", "rv"].includes(cp.current_step)) fail("HANDOFF_RECONCILIATION_INVALID");
    const conversationId = cp.current_step === "rv" ? record.rv_conversation_id : record.se_conversation_id;
    const evidence = executionCheckpoint && cp.execution_id ? await executionCheckpoint.load(conversationId, cp.execution_id) : null;
    const observed = await workspace();
    const stopped = Boolean(evidence?.runner_stopped_at && evidence.status !== "running" && Array.isArray(evidence.pending_tool_calls) && !evidence.pending_tool_calls.length && Array.isArray(evidence.completed_tool_calls));
    const safe = stopped && !evidence.handoff_result && same(cp.workspace, observed) && (cp.current_step !== "rv" || evidence.read_only_enforced === true) && (cp.current_step !== "se" || evidence.last_completed_step === 0 && !evidence.completed_tool_calls?.some((call) => call.mutating));
    if (!safe || !operatorApproved) return { classification: safe ? "operator_decision" : "blocked", handoff_id: handoffId };
    const updated = await store.transition(handoffId, cp.generation, (current) => {
      if (current.checkpoint.execution_id !== cp.execution_id || current.checkpoint.execution_status !== cp.execution_status) fail("HANDOFF_STALE");
      return { ...current, checkpoint: { ...current.checkpoint, current_step: null, next_step: cp.current_step, execution_status: "pending", error_code: null, updated_at: now() } };
    });
    log(updated, "reconciled");
    return { classification: "safe_to_resume", handoff_id: handoffId };
  }

  // Business purpose: resumes precisely the next incomplete role without creating another handoff.
  // Technical description: persists intent before invoking the adapter, then fences its result and preserves unknown outcomes.
  async function resume(handoffId, { invoke, recoverResult, expectedRevision, expectedSha256, expectedOwnerId } = {}) {
    const record = await store.get(handoffId);
    if (!record?.checkpoint) fail("HANDOFF_CHECKPOINT_REQUIRED");
    if (!Number.isInteger(record.checkpoint.generation) || record.checkpoint.generation < 1) fail("HANDOFF_CHECKPOINT_INVALID");
    if (record.status === "completed" || record.checkpoint.execution_status === "completed") fail("HANDOFF_ALREADY_COMPLETED");
    if (expectedRevision !== undefined && expectedRevision !== record.plan_revision || expectedSha256 !== undefined && expectedSha256 !== record.plan_sha256) fail("HANDOFF_PLAN_MISMATCH");
    if (record.checkpoint.approved_owner_id && expectedOwnerId && record.checkpoint.approved_owner_id !== expectedOwnerId) fail("PLAN_APPROVAL_OWNER_MISMATCH");
    await verifyPlan(record);
    const cp = record.checkpoint;
    if (cp.execution_status === "running") {
      const conversationId = cp.current_step === "se" ? record.se_conversation_id : cp.current_step === "rv" ? record.rv_conversation_id : record.am_conversation_id;
      const receipt = executionCheckpoint && conversationId && cp.execution_id ? await executionCheckpoint.load(conversationId, cp.execution_id) : null;
      if (receipt?.execution_id === cp.execution_id && receipt?.runner_stopped_at && receipt?.status === "completed" && Array.isArray(receipt.pending_tool_calls) && receipt.pending_tool_calls.length === 0 && Array.isArray(receipt.completed_tool_calls) && receipt.handoff_result?.execution_id === cp.execution_id) {
        const recovered = typeof recoverResult === "function" ? recoverResult(cp.current_step, receipt.handoff_result) : receipt.handoff_result;
        return complete(handoffId, record, recovered);
      }
      if (receipt?.runner_stopped_at && receipt.status !== "running") {
        const uncertain = await store.transition(handoffId, cp.generation, (current) => {
          if (current.checkpoint.execution_id !== cp.execution_id || current.checkpoint.execution_status !== "running") fail("HANDOFF_STALE");
          return { ...current, checkpoint: { ...current.checkpoint, execution_status: cp.current_step === "se" ? "reconciliation_required" : "unknown", error_code: "HANDOFF_EXECUTION_UNKNOWN", updated_at: now() } };
        });
        log(uncertain, "unknown", "HANDOFF_EXECUTION_UNKNOWN");
        return uncertain;
      }
      fail("HANDOFF_BUSY");
    }
    if (record.project_id !== projectId || !cp.plan_locked || !cp.workspace || !Array.isArray(cp.results)) fail("HANDOFF_CHECKPOINT_INVALID");
    if (["reconciliation_required", "unknown", "blocked"].includes(cp.execution_status)) fail("HANDOFF_RECONCILIATION_REQUIRED");
    if (cp.execution_status !== "pending" || !["se", "rv", "am"].includes(cp.next_step) || cp.round > record.max_rounds) fail("HANDOFF_TRANSITION_INVALID");
    if (cp.next_step === "rv" && !cp.results.some((r) => r.round === cp.round && r.step === "se") || cp.next_step === "am" && !cp.results.some((r) => r.round === cp.round && r.step === "rv" && r.verdict === "PASS")) fail("HANDOFF_PREDECESSOR_REQUIRED");
    if (!same(cp.workspace, await workspace())) fail("HANDOFF_WORKSPACE_MISMATCH");
    const step = cp.next_step;
    const executionId = `CORR-HANDOFF-${record.plan_id}-${step.toUpperCase()}-R${cp.round}-${randomUUID()}`;
    const intent = await store.transition(handoffId, cp.generation, (current) => {
      if (current.checkpoint.execution_status !== "pending" || current.checkpoint.next_step !== step) fail("HANDOFF_STALE");
      return { ...current, checkpoint: { ...current.checkpoint, current_step: step, next_step: null, execution_status: "running", execution_id: executionId, attempt: current.checkpoint.attempt + 1, error_code: null, started_at: now(), updated_at: now() } };
    });
    log(intent, "intent");
    let result;
    try {
      if (typeof invoke !== "function") fail("HANDOFF_ADAPTER_UNAVAILABLE");
      result = await invoke({ record: intent, step, round: cp.round, executionId, previous: cp.results });
    } catch (error) {
      const status = step === "se" ? "reconciliation_required" : "unknown";
      const failed = await store.transition(handoffId, intent.checkpoint.generation, (current) => {
        if (current.checkpoint.execution_id !== executionId || current.checkpoint.execution_status !== "running") fail("HANDOFF_STALE");
        return { ...current, checkpoint: { ...current.checkpoint, execution_status: status, error_code: "HANDOFF_EXECUTION_UNKNOWN", updated_at: now() } };
      });
      log(failed, "unknown", "HANDOFF_EXECUTION_UNKNOWN");
      return failed;
    }
    return complete(handoffId, intent, result);
  }
  return Object.freeze({ initialize, resume, reconcile, verifyPlan });
}
