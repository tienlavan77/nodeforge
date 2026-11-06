// Business purpose: retain each AM-SE plan critique turn so a failed handoff can resume without replaying a completed role.
// Technical description: persists fenced SE and AM intent/results, a pinned plan identity and critique round in the existing handoff store; uncertain attempts require a stopped SDK receipt and unchanged workspace before any retry.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";
import { handoffWorkspaceSnapshot } from "./am-se-handoff-workspace.js";

// Business purpose: expose a separate checkpoint for the plan critique before implementation starts.
// Technical description: claims each role invocation with store generation, checks the SDK receipt before replay, and retains a durable step result before processing the next role.
export function createAmSeCritiqueCheckpoint({ store, fileService, executionCheckpoint, gitService, projectId, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const MAX_TRANSIENT_RETRIES = 6;
  const TRANSIENT_STATUSES = new Set([429, 502, 503]);
  const fail = (code) => { throw Object.assign(new ConfigurationError(code), { code, statusCode: 409 }); };
  const snapshot = () => gitService ? handoffWorkspaceSnapshot({ gitService, fileService, projectId }) : null;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const key = (record, step) => step === "am" ? record.am_conversation_id : record.se_conversation_id;
  const clock = () => new Date().toISOString();

  // Business purpose: pin the first critique step before any provider is invoked.
  // Technical description: initializes a durable checkpoint while the handoff still has no implementation checkpoint.
  async function initialize(handoffId) {
    const record = await store.get(handoffId);
    if (!record || record.project_id !== projectId || record.phase !== "plan_critique" || record.critique_checkpoint) fail("HANDOFF_CRITIQUE_INVALID");
    const workspace = await snapshot();
    return store.update(handoffId, { critique_checkpoint: { generation: 0, round: 1, next_step: "se", current_step: null, execution_status: "pending", attempt: 0, results: [], workspace, plan_revision: record.plan_revision, plan_sha256: record.plan_sha256, updated_at: clock() } });
  }

  // Business purpose: recover only a definitively stopped attempt whose tool receipts cannot have mutated the workspace.
  // Technical description: checks stopped runner, empty pending calls, no handoff result, zero completed mutations and an unchanged snapshot; otherwise refuses automatic replay.
  async function safeToRetry(record, cp) {
    const evidence = executionCheckpoint && cp.execution_id ? await executionCheckpoint.load(key(record, cp.current_step), cp.execution_id) : null;
    if (!evidence?.runner_stopped_at || evidence.status === "running" || evidence.handoff_result || !Array.isArray(evidence.pending_tool_calls) || evidence.pending_tool_calls.length || !Array.isArray(evidence.completed_tool_calls) || evidence.completed_tool_calls.some((call) => call.mutating) || evidence.last_completed_step !== 0) return false;
    return same(cp.workspace, await snapshot());
  }

  // Business purpose: claim and finish one SE or AM critique turn without losing a previous completed answer.
  // Technical description: returns the saved result when already complete; a new invocation is fenced with a unique ID and requires an SDK terminal receipt before advancing.
  async function run(handoffId, { step, round, invoke }) {
    let record = await store.get(handoffId);
    if (!record || record.project_id !== projectId || record.phase !== "plan_critique" || !record.critique_checkpoint) fail("HANDOFF_CRITIQUE_INVALID");
    let cp = record.critique_checkpoint;
    if (cp.round !== round || !["se", "am"].includes(step)) fail("HANDOFF_CRITIQUE_STALE");
    if (cp.results.some((item) => item.step === step && item.round === round)) return { record, result: cp.results.find((item) => item.step === step && item.round === round) };
    if (["running", "unknown", "paused"].includes(cp.execution_status)) {
      if (cp.current_step !== step || !await safeToRetry(record, cp)) fail("HANDOFF_CRITIQUE_RECOVERY_REQUIRED");
      record = await store.transition(handoffId, cp.generation, (current) => ({ ...current, status: "paused", critique_checkpoint: { ...current.critique_checkpoint, current_step: null, next_step: step, execution_status: "pending", error_code: null, updated_at: clock() } }));
      cp = record.critique_checkpoint;
    }
    if (cp.execution_status !== "pending" || cp.next_step !== step || cp.plan_revision !== record.plan_revision || cp.plan_sha256 !== record.plan_sha256 || step === "am" && !cp.results.some((item) => item.step === "se" && item.round === round) || !same(cp.workspace, await snapshot())) fail("HANDOFF_CRITIQUE_STALE");
    const executionId = `CORR-HANDOFF-${record.plan_id}-CRITIQUE-${step.toUpperCase()}-R${round}-${randomUUID()}`;
    record = await store.transition(handoffId, cp.generation, (current) => {
      if (current.critique_checkpoint.execution_status !== "pending" || current.critique_checkpoint.next_step !== step) fail("HANDOFF_CRITIQUE_STALE");
      return { ...current, status: "critiquing", critique_checkpoint: { ...current.critique_checkpoint, current_step: step, next_step: null, execution_status: "running", execution_id: executionId, attempt: current.critique_checkpoint.attempt + 1, error_code: null, updated_at: clock() } };
    });
    let result;
    let transientAttempts = 0;
    while (true) {
      try { result = await invoke(executionId); break; } catch (error) {
        const status = Number(error?.status ?? error?.statusCode ?? error?.cause?.status);
        if (TRANSIENT_STATUSES.has(status) && transientAttempts < MAX_TRANSIENT_RETRIES) {
          transientAttempts += 1;
          await sleep(30_000);
          continue;
        }
        const code = error?.code === "EXECUTION_PAUSED" ? "EXECUTION_PAUSED" : TRANSIENT_STATUSES.has(status) ? "HANDOFF_TRANSIENT_RETRIES_EXHAUSTED" : "HANDOFF_EXECUTION_UNKNOWN";
        const latest = await store.get(handoffId);
        const interrupted = await store.transition(handoffId, latest.critique_checkpoint.generation, (current) => ({ ...current, status: "paused", critique_checkpoint: { ...current.critique_checkpoint, execution_status: "unknown", error_code: code, transient_attempts: transientAttempts, updated_at: clock() } }));
        return { record: interrupted, error };
      }
    }
    const text = typeof result === "string" ? result : result?.text;
    const valid = typeof text === "string" && text.trim() && (typeof result === "string" ? !executionCheckpoint : result.execution_id === executionId && result.terminal_status === "completed" && result.result_evidence?.sdk_status === "completed");
    if (!valid) {
      const latest = await store.get(handoffId);
      const unknown = await store.transition(handoffId, latest.critique_checkpoint.generation, (current) => ({ ...current, status: "paused", critique_checkpoint: { ...current.critique_checkpoint, execution_status: "unknown", error_code: "HANDOFF_RESULT_REQUIRED", updated_at: clock() } }));
      return { record: unknown };
    }
    const latest = await store.get(handoffId);
    const saved = await store.transition(handoffId, latest.critique_checkpoint.generation, (current) => {
      if (current.critique_checkpoint.current_step !== step || current.critique_checkpoint.execution_id !== executionId || current.critique_checkpoint.execution_status !== "running") fail("HANDOFF_CRITIQUE_STALE");
      const entry = { step, round, text: text.trim(), execution_id: executionId, completed_at: clock() };
      return { ...current, critique_checkpoint: { ...current.critique_checkpoint, current_step: null, next_step: step === "se" ? "am" : "se", execution_status: "pending", results: [...current.critique_checkpoint.results, entry], updated_at: clock() } };
    });
    return { record: saved, result: saved.critique_checkpoint.results.at(-1) };
  }

  // Business purpose: close a completed critique round only after its source revision and history are durably recorded.
  // Technical description: atomically pins the next round and source identity with a generation claim; implementation initialization remains in the existing approved-plan gate.
  async function advance(handoffId, { round, history, plan }) {
    const record = await store.get(handoffId);
    const cp = record?.critique_checkpoint;
    if (!cp || cp.round !== round || cp.execution_status !== "pending" || !cp.results.some((item) => item.round === round && item.step === "se") || plan.revision < record.plan_revision) fail("HANDOFF_CRITIQUE_STALE");
    return store.transition(handoffId, cp.generation, (current) => ({ ...current, history, critique_round: round + 1, plan_revision: plan.revision, plan_sha256: plan.sha256, plan_source_path: plan.source_path, critique_checkpoint: { ...current.critique_checkpoint, round: round + 1, next_step: "se", workspace: cp.workspace, plan_revision: plan.revision, plan_sha256: plan.sha256, updated_at: clock() } }));
  }
  return Object.freeze({ initialize, run, advance });
}
