// Persists direct System Engineer execution checkpoints so interrupted work can be resumed safely.
import { createHash, randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";
import { acquireTicketFileLock } from "../modules/supervisor/ticket-file-lock.js";

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
export function createOwnerExecutionCheckpoint({ fileService, gitService, root = ROOT, ownerInstanceId = randomUUID() }) {
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
      if (!continueAttempt && !resumeOf && previous.some((entry) => entry.status === "interrupted")) throw Object.assign(new ConfigurationError("Choose Continue, Restart, or Discard for the interrupted execution first."), { code: "EXECUTION_DECISION_REQUIRED", statusCode: 409 });
      if (continueAttempt) {
        return update(conversationId, executionId, async (current) => {
          if (!current || current.user_prompt_hash !== promptHash || !await reconcile(current)) throw Object.assign(new ConfigurationError("Execution requires manual workspace reconciliation before continuation."), { code: "EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 });
          return { ...current, status: "running", pending_tool_calls: [], resume_count: (current.resume_count ?? 0) + 1, owner_instance_id: ownerInstanceId, lease_started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() };
        });
      }
      if (resumeOf && !await reconcile(await load(conversationId, resumeOf))) throw Object.assign(new ConfigurationError("Previous execution requires manual reconciliation before restart."), { code: "EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 });
      const started = await update(conversationId, executionId, (current) => {
        if (current) throw Object.assign(new ConfigurationError("Execution already exists."), { statusCode: 409 });
        return { status: "running", provider, message_id: messageId, user_prompt_hash: promptHash, provider_thread_id: null, completed_tool_calls: [], failed_tool_calls: [], pending_tool_calls: [], next_sequence: 1, changed_paths: [], resume_of: resumeOf, owner_instance_id: ownerInstanceId, lease_started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() };
      });
      if (resumeOf) await close(conversationId, resumeOf, "restarted");
      return started;
    } finally { await claim.release(); }
  }

  // Updates an owned checkpoint while preserving the lease and completed tool receipts.
  async function patch(conversationId, executionId, fields) {
    return update(conversationId, executionId, (current) => {
      if (!current) throw new ConfigurationError("Owner execution checkpoint does not exist.");
      if (current.status === "running" && current.owner_instance_id !== ownerInstanceId) throw Object.assign(new ConfigurationError("Execution lease belongs to another instance."), { code: "EXECUTION_BUSY", statusCode: 409 });
      return { ...current, ...fields, heartbeat_at: new Date().toISOString() };
    });
  }

  // Reclassifies stale running executions as interrupted after their heartbeat expires.
  async function inspect(conversationId) {
    const records = await list(conversationId);
    for (const record of records) {
      if (record.status === "running" && Date.now() - Date.parse(record.heartbeat_at) >= LEASE_MS) {
        await update(conversationId, record.execution_id, (current) => current.status === "running" && Date.now() - Date.parse(current.heartbeat_at) >= LEASE_MS ? { ...current, status: "interrupted", next_action_hint: "Lease expired; reconcile workspace before continuing." } : null);
      }
    }
    return list(conversationId);
  }

  // Records a tool boundary before a Forge call can mutate the workspace.
  async function beforeTool(conversationId, executionId, name, input) {
    let step;
    await update(conversationId, executionId, (current) => {
      if (current?.status !== "running" || current.owner_instance_id !== ownerInstanceId) throw Object.assign(new ConfigurationError("Execution is not active."), { code: "EXECUTION_INTERRUPTED" });
      if (current.resume_count && ["commit_changes", "push_commit"].includes(name) && current.completed_tool_calls.some((receipt) => receipt.tool_name === name)) throw Object.assign(new ConfigurationError("Git operation already completed in this execution; do not repeat it."), { code: "EXECUTION_RECONCILIATION_REQUIRED" });
      step = { sequence: current.next_sequence, tool_name: name, input_hash: executionDigest(input), mutating: MUTATING.has(name), ...(typeof input?.path === "string" ? { path: input.path } : {}), ...(typeof input?.before_checksum === "string" ? { before_checksum: input.before_checksum } : {}), started_at: new Date().toISOString() };
      return { ...current, next_sequence: current.next_sequence + 1, pending_tool_calls: [...current.pending_tool_calls, step], heartbeat_at: new Date().toISOString() };
    });
    return step;
  }

  // Stores a bounded receipt after a Forge tool returns successfully.
  async function afterTool(conversationId, executionId, step, result, changedPaths = []) {
    const receipt = { ...step, completed_at: new Date().toISOString(), result_hash: executionDigest(result), ...(typeof result?.sha256 === "string" ? { after_checksum: result.sha256 } : {}), ...(checksumFromResult(step, result) ? { after_checksum: checksumFromResult(step, result) } : {}), ...(step.tool_name === "commit_changes" && typeof result?.sha === "string" ? { commit_sha: result.sha } : {}) };
    return update(conversationId, executionId, (current) => {
      if (current?.owner_instance_id !== ownerInstanceId || current.status !== "running") throw Object.assign(new ConfigurationError("Execution lease has ended."), { code: "EXECUTION_INTERRUPTED" });
      const previous = current.completed_tool_calls ?? [];
      return { ...current, pending_tool_calls: current.pending_tool_calls.filter((pending) => pending.sequence !== step.sequence), completed_tool_calls: [...previous, receipt].slice(-MAX_STEPS), receipts_truncated: current.receipts_truncated || previous.length >= MAX_STEPS, last_completed_step: Math.max(current.last_completed_step ?? 0, receipt.sequence), changed_paths: [...new Set([...current.changed_paths, ...changedPaths])].slice(-MAX_STEPS), heartbeat_at: new Date().toISOString() };
    });
  }

  // Records a failed Forge call while retaining uncertain write and Git boundaries for manual review.
  async function failTool(conversationId, executionId, step, error) {
    return update(conversationId, executionId, (current) => ({ ...current, pending_tool_calls: step.mutating ? current.pending_tool_calls : current.pending_tool_calls.filter((pending) => pending.sequence !== step.sequence), failed_tool_calls: [...current.failed_tool_calls, { sequence: step.sequence, tool_name: step.tool_name, error_code: String(error?.code ?? "TOOL_FAILED").slice(0, 80) }].slice(-MAX_STEPS) }));
  }

  // Extracts the resulting file checksum from a confirmed Forge write receipt.
  function checksumFromResult(step, result) {
    if (step.tool_name !== "write_diff") return null;
    const text = result?.content?.find?.((item) => item.type === "text")?.text ?? "";
    return text.match(/\(sha256:[a-f0-9]{64}\)/)?.[0]?.slice(1, -1) ?? null;
  }

  // Refuses to replay uncertain tool side effects after a process interruption.
  function canContinue(record) {
    return record?.status === "interrupted" && !record.receipts_truncated && !(record.pending_tool_calls ?? []).some((step) => step.mutating) && !record.completed_tool_calls?.some((step) => ["push_commit", "delete_file"].includes(step.tool_name));
  }

  // Confirms completed file writes still match the workspace before continuing.
  async function reconcile(record) {
    if (!canContinue(record)) return false;
    const committed = [...(record.completed_tool_calls ?? [])].reverse().find((step) => step.tool_name === "commit_changes");
    if (committed && (!committed.commit_sha || typeof gitService?.getHead !== "function" || (await gitService.getHead()).toLowerCase() !== committed.commit_sha.toLowerCase())) return false;
    const verifiedPaths = new Set();
    for (const step of [...(record.completed_tool_calls ?? [])].reverse()) {
      if (!["write_diff", "edit_diff"].includes(step.tool_name) || verifiedPaths.has(step.path)) continue;
      if (!step.path || !step.after_checksum) return false;
      verifiedPaths.add(step.path);
      try {
        const content = await fileService.readFile({ path: step.path });
        if (`sha256:${createHash("sha256").update(content).digest("hex")}` !== step.after_checksum) return false;
      } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }
    return true;
  }

  // Retains audit evidence when the owner discards or restarts an interrupted execution.
  async function close(conversationId, executionId, status) {
    if (!["discarded", "restarted"].includes(status)) throw new ConfigurationError("Invalid execution close status.");
    return update(conversationId, executionId, (current) => {
      if (!current || current.status !== "interrupted") throw Object.assign(new ConfigurationError("Only an interrupted execution can be closed."), { statusCode: 409 });
      return { ...current, status };
    });
  }

  return Object.freeze({ load, list, start, patch, inspect, beforeTool, afterTool, failTool, canContinue, reconcile, close, ownerInstanceId, terminalStatuses: TERMINAL });
}
