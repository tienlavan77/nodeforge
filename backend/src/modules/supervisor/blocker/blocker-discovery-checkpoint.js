// Replenishes recovery discovery allowances at durable tool boundaries without restarting the agent turn.
import { createHash } from "node:crypto";

// Binds discovery progress to the exact role, assignment and retained ticket execution.
export function discoveryAssignment(job) {
  return createHash("sha256").update(JSON.stringify([job?.id, job?.stage, job?.request?.payload?.execution_id,
    job?.coder_exchange?.request_id, job?.coder_exchange?.candidate?.sha256, job?.stage === "coder" ? null : job?.history?.at(-1)?.completed_at])).digest("hex");
}

// Records completed reads before returning their result and extends allowances inside the same SDK invocation.
export function createDiscoveryProgress({ job, save = async () => {}, clock = Date.now, deadline = Infinity, abortSignal, onRenew = () => {} }) {
  const assignment_id = discoveryAssignment(job);
  const prior = job?.discovery_checkpoints?.[job.stage];
  const checkpoint = prior?.assignment_id === assignment_id ? structuredClone(prior)
    : { assignment_id, role: job?.stage, sequence: 0, calls: 0, bytes: 0, call_allowance: 30, byte_allowance: 120_000, renewals: 0, receipts: [] };
  let pending = Promise.resolve();
  let failure;
  return { assertActive, complete, snapshot: () => structuredClone(checkpoint) };

  // Stops new tool work when the retained execution is cancelled or its original deadline expires.
  function assertActive() {
    if (failure) throw failure;
    if (abortSignal?.aborted || clock() >= deadline) throw Object.assign(new Error("Recovery discovery stopped; checkpoint retained."), { code: "BLOCKER_DISCOVERY_STOPPED" });
  }

  // Saves the exact completed tool identity and cumulative counters before granting another allowance slice.
  function complete(tool, input, result, paths) {
    const operation = pending.then(() => record(tool, input, result, paths));
    pending = operation.then(() => undefined, (error) => { failure = error; });
    return operation;
  }

  // Serializes checkpoint grants so parallel tool completions cannot bypass a failed renewal or Stop.
  async function record(tool, input, result, paths) {
    assertActive();
    checkpoint.calls += 1;
    checkpoint.bytes += Buffer.byteLength(JSON.stringify(result));
    const renewed = checkpoint.calls > checkpoint.call_allowance || checkpoint.bytes > checkpoint.byte_allowance;
    if (renewed) {
      checkpoint.call_allowance = Math.max(checkpoint.call_allowance, Math.ceil(checkpoint.calls / 30) * 30);
      checkpoint.byte_allowance = Math.max(checkpoint.byte_allowance, Math.ceil(checkpoint.bytes / 120_000) * 120_000);
      checkpoint.renewals += 1;
    }
    checkpoint.sequence += 1;
    checkpoint.paths = [...paths];
    checkpoint.receipts.push({ tool, input: structuredClone(input), result_sha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
      source_sha256: result?.sha256 ?? null, completed_at: clock() });
    await save(structuredClone(checkpoint), { renewed });
    assertActive();
    if (renewed) onRenew({ calls: checkpoint.calls, bytes: checkpoint.bytes, renewals: checkpoint.renewals });
  }
}

// Fences progress writes against Stop, execution replacement and other workers before granting a continuation.
export function createDiscoveryCheckpointWriter({ store, ledgerId, job, validate }) {
  return async (checkpoint, { renewed } = {}) => {
    if (checkpoint.assignment_id !== discoveryAssignment(job) || renewed && !await validate(job)) throw Object.assign(new Error("Discovery source or assignment changed."), { code: "BLOCKER_DISCOVERY_STALE" });
    await store.withLock("blocker.recovery", async () => {
      const ledger = (await store.list("blocker.recovery")).find((entry) => entry.id === ledgerId);
      const current = ledger?.jobs.find((entry) => entry.id === job.id);
      if (ledger?.cancelled || !current || current.status !== "invoking" || current.stage !== job.stage || current.invocation_id !== job.invocation_id
        || ledger.execution_id !== job.request.payload.execution_id) throw Object.assign(new Error("Discovery no longer owns this execution."), { code: "BLOCKER_DISCOVERY_STOPPED" });
      current.discovery_checkpoints ??= {};
      const previous = current.discovery_checkpoints[job.stage];
      if (previous?.assignment_id === checkpoint.assignment_id && previous.sequence >= checkpoint.sequence) return;
      current.discovery_checkpoints[job.stage] = checkpoint;
      await store.save("blocker.recovery", ledger);
    });
  };
}

// Supplies retained read progress on explicit resume without claiming a lost provider session still exists.
export function discoveryCheckpointPrompt(job) {
  const checkpoint = job.discovery_checkpoints?.[job.stage];
  return checkpoint ? `RETAINED DISCOVERY CHECKPOINT: ${JSON.stringify(checkpoint)}. Continue from completed reads and the next unfinished task. Do not restart source enumeration. Source hashes are historical observations; re-read only when current contents or drift checks require it. Allowance renewal happens in Node during this same tool call; it is not an Architecture question or a new agent assignment.` : "";
}
