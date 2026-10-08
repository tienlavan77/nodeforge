// Persists direct System Engineer execution checkpoints so interrupted work can be resumed safely.
import { createHash, randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";
import { acquireTicketFileLock } from "../modules/supervisor/ticket-file-lock.js";
import { prepareArchitectureMutation, verifyArchitectureMutation } from "./architecture-reconciliation.js";

const ROOT = ".forge/runtime/owner-executions";
const LEASE_MS = 30_000;
const MAX_STEPS = 80;
const TERMINAL = new Set(["completed", "discarded", "restarted"]);
const MUTATING = new Set(["write_diff", "edit_diff", "delete_file", "run_check", "commit_changes", "push_commit"]);

// Hashes a prompt or tool input without storing sensitive source material in the checkpoint.
export function executionDigest(value) {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

// Creates a File Service-backed checkpoint store with per-conversation atomic updates and leases.
export function createOwnerExecutionCheckpoint({ fileService, gitService, root = ROOT, role = "system_engineer", ownerInstanceId = randomUUID() }) {
  if (!fileService?.atomicWrite || !fileService?.readFile || !fileService?.createLock) throw new ConfigurationError("Owner execution checkpoint requires File Service persistence and locks.");

  // Maps a conversation and execution to a private, traversal-safe runtime record.
  function pathFor(conversationId, executionId) {
    return `${root}/${executionDigest(conversationId).slice(0, 32)}-${executionDigest(executionId).slice(0, 32)}.json`;
  }

  // Reads a checkpoint without making assumptions about an absent file.
  async function load(conversationId, executionId) {
    try { return JSON.parse(await fileService.readFile({ path: pathFor(conversationId, executionId) })); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  // Enumerates a conversation's attempts, retaining finished attempts for audit.
  async function list(conversationId) {
    const prefix = executionDigest(conversationId).slice(0, 32);
    const paths = (await fileService.listFiles({ glob: `${root}/*.json` })).filter((path) => path.startsWith(`${root}/${prefix}-`));
    const records = [];
    for (const path of paths) {
      const record = JSON.parse(await fileService.readFile({ path }));
      if (record.conversation_id === conversationId) records.push(record);
    }
    return records.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  // Serializes an execution transition and rejects concurrent owners of a live lease.
  async function update(conversationId, executionId, modify) {
    const path = pathFor(conversationId, executionId);
    const lock = await acquireTicketFileLock(fileService, `${path}.lock`);
    try {
      const current = await load(conversationId, executionId);
      const next = await modify(current);
      if (!next) return current;
      const record = { ...next, conversation_id: conversationId, execution_id: executionId, updated_at: new Date().toISOString() };
      await fileService.atomicWrite({ path, content: `${JSON.stringify(record)}\n`, replace: true });
      return record;
    } finally { await lock.release(); }
  }

  // Reserves a single execution lease for a direct System Engineer turn.
  async function start({ conversationId, executionId, messageId, provider, promptHash, resumeOf = null, continueAttempt = false }) {
    const claim = await acquireTicketFileLock(fileService, `${root}/${executionDigest(conversationId).slice(0, 32)}.lock`);
    try {
      const previous = await inspect(conversationId);
      const live = previous.find((entry) => entry.status === "running" && Date.now() - Date.parse(entry.heartbeat_at) < LEASE_MS);
      if (live) throw Object.assign(new ConfigurationError("A System Engineer execution is already running in this conversation."), { code: "EXECUTION_BUSY", statusCode: 409 });
      if (!continueAttempt && !resumeOf && previous.some((entry) => ["interrupted", "manual_required"].includes(entry.status))) throw Object.assign(new ConfigurationError("Choose Continue, Restart, or Discard for the interrupted execution first."), { code: "EXECUTION_DECISION_REQUIRED", statusCode: 409 });
      if (continueAttempt) {
        return update(conversationId, executionId, async (current) => {
          if (!current || current.user_prompt_hash !== promptHash || !await reconcile(current)) throw Object.assign(new ConfigurationError("Execution requires manual workspace reconciliation before continuation."), { code: "EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 });
          return { ...current, status: "running", runner_stopped_at: null, pending_tool_calls: [], resume_count: (current.resume_count ?? 0) + 1, owner_instance_id: ownerInstanceId, lease_started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() };
        });
      }
      const parent = resumeOf ? await load(conversationId, resumeOf) : null;
      if (resumeOf && (!parent || !await reconcile(parent))) throw Object.assign(new ConfigurationError("Previous execution requires manual reconciliation before restart."), { code: "EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 });
      const started = await update(conversationId, executionId, (current) => {
        if (current) throw Object.assign(new ConfigurationError("Execution already exists."), { statusCode: 409 });
        return { status: "running", role, provider, message_id: messageId, user_prompt_hash: promptHash, provider_thread_id: null, completed_tool_calls: [...(parent?.completed_tool_calls ?? [])], failed_tool_calls: [...(parent?.failed_tool_calls ?? [])], pending_tool_calls: [...(parent?.pending_tool_calls ?? [])], next_sequence: parent?.next_sequence ?? 1, changed_paths: [...(parent?.changed_paths ?? [])], last_completed_step: parent?.last_completed_step ?? 0, receipts_truncated: parent?.receipts_truncated ?? false, lineage_id: parent?.lineage_id ?? resumeOf ?? executionId, attempt_number: (parent?.attempt_number ?? 0) + 1, resume_of: resumeOf, owner_instance_id: ownerInstanceId, lease_started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() };
      });
      if (resumeOf) await close(conversationId, resumeOf, "restarted");
      return started;
    } finally { await claim.release(); }
  }

  // Updates an owned checkpoint while preserving the lease and completed tool receipts.
  async function patch(conversationId, executionId, fields) {
    return update(conversationId, executionId, (current) => {
      if (!current) throw new ConfigurationError("Owner execution checkpoint does not exist.");
      if (current.owner_instance_id !== ownerInstanceId || (role === "architecture_manager" && current.status === "manual_required")) throw Object.assign(new ConfigurationError("Execution lease belongs to another instance or requires manual review."), { code: "EXECUTION_BUSY", statusCode: 409 });
      return { ...current, ...fields, heartbeat_at: new Date().toISOString() };
    });
  }

  // Reclassifies stale running executions as interrupted after their heartbeat expires.
  async function inspect(conversationId) {
    const records = await list(conversationId);
    for (const record of records) {
      const laterSequence = [...(record.completed_tool_calls ?? []), ...(record.pending_tool_calls ?? [])].filter((step) => step.sequence > 0).reduce((max, step) => Math.max(max, step.sequence), 0);
      if (role === "system_engineer" && laterSequence > 0 && (record.pending_tool_calls ?? []).some((step) => step.tool_name === "run_check" && step.sequence < laterSequence)) {
        await update(conversationId, record.execution_id, (current) => current.status === record.status ? settleReturnedRunChecks(current, laterSequence) : null);
      }
      if (record.status === "running" && Date.now() - Date.parse(record.heartbeat_at) >= LEASE_MS) {
        await update(conversationId, record.execution_id, (current) => current.status === "running" && Date.now() - Date.parse(current.heartbeat_at) >= LEASE_MS ? { ...current, status: current.pending_tool_calls.some((step) => step.mutating) ? "manual_required" : "interrupted", interruption_source: "lease_expired", next_action_hint: "Lease expired; verify the runner stopped before continuing." } : null);
      }
    }
    return list(conversationId);
  }

  // Records a tool boundary before a Forge call can mutate the workspace.
  async function beforeTool(conversationId, executionId, name, input) {
    let step;
    await update(conversationId, executionId, async (current) => {
      if (current?.status !== "running" || current.owner_instance_id !== ownerInstanceId) throw Object.assign(new ConfigurationError("Execution is not active."), { code: "EXECUTION_INTERRUPTED" });
      current = settleReturnedRunChecks(current, current.next_sequence);
      if (role === "architecture_manager" && current.pending_tool_calls.some((pending) => pending.mutating)) throw Object.assign(new ConfigurationError("Another document mutation has not completed."), { code: "EXECUTION_BUSY", statusCode: 409 });
      if (role === "architecture_manager" && MUTATING.has(name) && !["write_diff", "edit_diff", "delete_file"].includes(name)) throw Object.assign(new ConfigurationError("Architecture recovery cannot execute System Engineer mutations."), { code: "TOOL_FORBIDDEN" });
      if ((current.resume_count || current.resume_of) && current.completed_tool_calls.some((receipt) => receipt.tool_name === name && (["commit_changes", "push_commit"].includes(name) || (MUTATING.has(name) && receipt.input_hash === executionDigest(input))))) throw Object.assign(new ConfigurationError("Side effect already completed; cannot replay after recovery."), { code: "EXECUTION_RECONCILIATION_REQUIRED" });
      const evidence = role === "architecture_manager" && MUTATING.has(name) ? await prepareArchitectureMutation(fileService, name, input) : {};
      step = { sequence: current.next_sequence, tool_name: name, input_hash: executionDigest(input), mutating: MUTATING.has(name), ...(typeof input?.path === "string" ? { path: input.path } : {}), ...(typeof input?.before_checksum === "string" ? { before_checksum: input.before_checksum } : {}), ...evidence, started_at: new Date().toISOString() };
      return { ...current, next_sequence: current.next_sequence + 1, active_mutations: (current.active_mutations ?? 0) + (role === "architecture_manager" && step.mutating ? 1 : 0), pending_tool_calls: [...current.pending_tool_calls, step], heartbeat_at: new Date().toISOString() };
    });
    return step;
  }

  // Stores a bounded receipt after a Forge tool returns successfully.
  async function afterTool(conversationId, executionId, step, result, changedPaths = []) {
    const receipt = { ...step, completed_at: new Date().toISOString(), result_hash: executionDigest(result), ...(typeof result?.sha256 === "string" ? { after_checksum: result.sha256 } : {}), ...(checksumFromResult(step, result) ? { after_checksum: checksumFromResult(step, result) } : {}), ...(step.tool_name === "commit_changes" && typeof result?.sha === "string" ? { commit_sha: result.sha } : {}) };
    return update(conversationId, executionId, (current) => {
      if (current?.owner_instance_id !== ownerInstanceId || current.status !== "running") throw Object.assign(new ConfigurationError("Execution lease has ended."), { code: "EXECUTION_INTERRUPTED" });
      const previous = current.completed_tool_calls ?? [];
      return { ...current, active_mutations: Math.max(0, (current.active_mutations ?? 0) - (role === "architecture_manager" && step.mutating ? 1 : 0)), pending_tool_calls: current.pending_tool_calls.filter((pending) => pending.sequence !== step.sequence), completed_tool_calls: [...previous, receipt].slice(-MAX_STEPS), receipts_truncated: current.receipts_truncated || previous.length >= MAX_STEPS, last_completed_step: Math.max(current.last_completed_step ?? 0, receipt.sequence), changed_paths: [...new Set([...current.changed_paths, ...changedPaths])].slice(-MAX_STEPS), heartbeat_at: new Date().toISOString() };
    });
  }

  // Records a failed Forge call while retaining uncertain write and Git boundaries for manual review.
  async function failTool(conversationId, executionId, step, error) {
    return update(conversationId, executionId, (current) => {
      if (current?.owner_instance_id !== ownerInstanceId || current.status !== "running") throw Object.assign(new ConfigurationError("Execution lease has ended."), { code: "EXECUTION_INTERRUPTED" });
      const safelyCancelledCheck = step.tool_name === "run_check" && error?.code === "EXECUTION_PAUSED";
      return { ...current, active_mutations: Math.max(0, (current.active_mutations ?? 0) - (role === "architecture_manager" && step.mutating ? 1 : 0)), status: role === "architecture_manager" && step.mutating && !safelyCancelledCheck ? "manual_required" : current.status, pending_tool_calls: step.mutating && !safelyCancelledCheck ? current.pending_tool_calls : current.pending_tool_calls.filter((pending) => pending.sequence !== step.sequence), failed_tool_calls: [...current.failed_tool_calls, { sequence: step.sequence, tool_name: step.tool_name, error_code: String(error?.code ?? "TOOL_FAILED").slice(0, 80) }].slice(-MAX_STEPS) };
    });
  }

  // Extracts the resulting file checksum from a confirmed Forge write receipt.
  function checksumFromResult(step, result) {
    if (step.tool_name !== "write_diff") return null;
    const text = result?.content?.find?.((item) => item.type === "text")?.text ?? "";
    return text.match(/\(sha256:[a-f0-9]{64}\)/)?.[0]?.slice(1, -1) ?? null;
  }

  // Settles an old run_check boundary only when a later tool sequence proves its call returned.
  function settleReturnedRunChecks(record, evidenceSequence) {
    const unsettled = (record.pending_tool_calls ?? []).filter((step) => step.tool_name === "run_check" && step.sequence < evidenceSequence);
    if (!unsettled.length) return record;
    const settled = unsettled.map((step) => {
      const failure = (record.failed_tool_calls ?? []).find((entry) => entry.sequence === step.sequence);
      return { sequence: step.sequence, tool_name: "run_check", outcome: failure ? "failed" : "unknown", ...(failure ? { error_code: failure.error_code } : {}), evidence_sequence: evidenceSequence, settled_at: new Date().toISOString(), evidence_hash: executionDigest({ execution_id: record.execution_id, sequence: step.sequence, evidence_sequence: evidenceSequence, outcome: failure?.error_code ?? "unknown" }) };
    });
    return { ...record, pending_tool_calls: record.pending_tool_calls.filter((step) => !unsettled.some((entry) => entry.sequence === step.sequence)), settled_tool_calls: [...(record.settled_tool_calls ?? []), ...settled].slice(-MAX_STEPS) };
  }

  // Refuses to replay uncertain tool side effects after a process interruption.
  function canContinue(record) {
    return record?.status === "interrupted" && Boolean(record.runner_stopped_at) && !record.receipts_truncated && !(record.pending_tool_calls ?? []).some((step) => step.mutating) && !record.completed_tool_calls?.some((step) => step.tool_name === "push_commit" || (step.tool_name === "delete_file" && (role !== "architecture_manager" || !step.expected_absent)));
  }

  // Confirms completed file writes still match the workspace before continuing.
  async function reconcile(record) {
    if (!canContinue(record)) return false;
    const committed = [...(record.completed_tool_calls ?? [])].reverse().find((step) => step.tool_name === "commit_changes");
    if (committed && (!committed.commit_sha || typeof gitService?.getHead !== "function" || (await gitService.getHead()).toLowerCase() !== committed.commit_sha.toLowerCase())) return false;
    const verifiedPaths = new Set();
    for (const step of [...(record.completed_tool_calls ?? [])].reverse()) {
      if (!["write_diff", "edit_diff", "delete_file"].includes(step.tool_name) || verifiedPaths.has(step.path)) continue;
      if (!step.path || (step.tool_name !== "delete_file" && !step.after_checksum)) return false;
      verifiedPaths.add(step.path);
      if (step.tool_name === "delete_file") {
        if (!await verifyArchitectureMutation(fileService, step)) return false;
        continue;
      }
      try {
        const content = await fileService.readFile({ path: step.path });
        if (`sha256:${createHash("sha256").update(content).digest("hex")}` !== step.after_checksum) return false;
      } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }
    return true;
  }

  // Certifies that the local runner has exited and no document mutation remains in flight.
  async function markStopped(conversationId, executionId) {
    return update(conversationId, executionId, (current) => current?.owner_instance_id === ownerInstanceId && !(current.active_mutations ?? 0) ? { ...current, runner_stopped_at: new Date().toISOString() } : null);
  }

  // Records recovery evidence after the API confirms no runner or mutating tool remains active.
  async function markRecoveredStopped(conversationId, executionId) {
    return update(conversationId, executionId, (current) => current?.status === "interrupted" && !(current.active_mutations ?? 0) && !(current.pending_tool_calls ?? []).some((step) => step.mutating) ? { ...current, runner_stopped_at: current.runner_stopped_at ?? new Date().toISOString(), runner_stop_evidence: "no_active_sdk_runner_or_pending_mutation" } : null);
  }

  // Confirms an uncertain Architecture write only after runner exit and an exact document-state match.
  async function reconcilePending(conversationId, executionId, sequence, actorId) {
    if (role !== "architecture_manager" || !actorId || !Number.isSafeInteger(sequence)) throw new ConfigurationError("Architecture reconciliation requires an actor label and step.");
    return update(conversationId, executionId, async (current) => {
      if (current?.status !== "manual_required" || !current.runner_stopped_at || current.active_mutations || current.receipts_truncated) throw Object.assign(new ConfigurationError("The previous runner has not safely stopped."), { code: "EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 });
      const pending = current.pending_tool_calls ?? [];
      if (pending.length !== 1 || pending[0].sequence !== sequence || !await verifyArchitectureMutation(fileService, pending[0])) throw Object.assign(new ConfigurationError("Document state does not prove the intended mutation."), { code: "EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 });
      const step = pending[0];
      const receipt = { ...step, after_checksum: step.expected_absent ? null : step.expected_after_checksum, reconciled_at: new Date().toISOString(), reconciled_by: actorId, evidence_hash: executionDigest({ sequence, path: step.path, after_checksum: step.expected_after_checksum, absent: step.expected_absent }) };
      return { ...current, status: "interrupted", pending_tool_calls: [], completed_tool_calls: [...current.completed_tool_calls, receipt].slice(-MAX_STEPS), receipts_truncated: current.completed_tool_calls.length >= MAX_STEPS, last_completed_step: Math.max(current.last_completed_step ?? 0, sequence), changed_paths: [...new Set([...(current.changed_paths ?? []), step.path])].slice(-MAX_STEPS), manual_reconciliations: [...(current.manual_reconciliations ?? []), receipt].slice(-MAX_STEPS), next_action_hint: "Document state verified; choose Continue or Restart." };
    });
  }

  // Retains audit evidence when the owner discards or restarts an interrupted execution.
  async function close(conversationId, executionId, status) {
    if (!["discarded", "restarted"].includes(status)) throw new ConfigurationError("Invalid execution close status.");
    return update(conversationId, executionId, (current) => {
      if (!current || !["interrupted", "manual_required"].includes(current.status)) throw Object.assign(new ConfigurationError("Only a stopped execution can be closed."), { statusCode: 409 });
      if (status === "discarded" && (current.active_mutations || !current.runner_stopped_at)) throw Object.assign(new ConfigurationError("Execution still has a running agent or tool."), { code: "EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 });
      return { ...current, status };
    });
  }

  return Object.freeze({ load, list, start, patch, inspect, beforeTool, afterTool, failTool, canContinue, reconcile, reconcilePending, markStopped, markRecoveredStopped, close, ownerInstanceId, terminalStatuses: TERMINAL });
}
