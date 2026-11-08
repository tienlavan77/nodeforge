// Business purpose: stores independent subagent worker state and verified evidence for parent conversations until plan acceptance.
// Technical description: maintains in-memory delegation records, checksummed evidence and serialized writes.
import { createHash } from "node:crypto";

const delegations = new Map();
const locks = new Map();
const delegationKey = (conversationId, delegationId, scopeType = "owner") => `${scopeType}:${conversationId ?? "unknown"}:${delegationId}`;
const checksum = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Business purpose: retrieves one conversation delegation record so workers share evidence without crossing conversation boundaries.
// Technical description: lazily creates versioned worker and evidence maps keyed by conversation and delegation.
function stateFor(conversationId, delegationId) {
  const id = delegationKey(conversationId, delegationId);
  if (!delegations.has(id)) delegations.set(id, { conversation_id: conversationId ?? null, delegation_id: delegationId, version: 0, workers: new Map(), evidence: new Map() });
  return delegations.get(id);
}

// Business purpose: prevents concurrent workers from overwriting evidence.
// Technical description: serializes asynchronous operations per delegation key.
async function withLock(id, operation) {
  const previous = locks.get(id) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(id, previous.then(() => current));
  await previous;
  try { return await operation(); } finally { release(); }
}

// Business purpose: exposes worker lifecycle and shared evidence to owner agents and reviewers.
// Technical description: records worker identity, heartbeat, final summaries, source worker IDs, checksums and monotonic versions.
export function createSubagentEvidenceStore() {
  return Object.freeze({
    startWorker({ conversationId, delegationId, workerId, parentAgentId = null, objective, eventSink } = {}) {
      const state = stateFor(conversationId, delegationId);
      state.workers.set(workerId, { worker_id: workerId, parent_agent_id: parentAgentId, agent_type: "subagent", objective, status: "running", heartbeat_at: new Date().toISOString(), result: null });
      eventSink?.({ event_type: "agent.activity", conversation_id: conversationId, payload: { activity_type: "subagent_started", agent_type: "subagent", status: "working", subagent_id: workerId, parent_agent_id: parentAgentId, delegation_id: delegationId } });
    },
    heartbeat({ conversationId, delegationId, workerId } = {}) {
      const worker = stateFor(conversationId, delegationId).workers.get(workerId);
      if (worker) worker.heartbeat_at = new Date().toISOString();
    },
    async complete({ conversationId, delegationId, workerId, parentAgentId = null, summary = "", observedFiles = [], usage = null, eventSink } = {}) {
      return withLock(delegationKey(conversationId, delegationId), async () => {
        const state = stateFor(conversationId, delegationId);
        const worker = state.workers.get(workerId);
        if (!worker) return null;
        const evidence = observedFiles.filter((file) => file?.path && file?.sha256).map((file) => ({ ...file, source_worker_id: workerId, delegation_id: delegationId, version: state.version + 1 }));
        for (const item of evidence) state.evidence.set(`${item.path}:${item.sha256}`, item);
        state.version += 1;
        worker.status = "completed";
        worker.heartbeat_at = new Date().toISOString();
        worker.result = { summary, usage, evidence_count: evidence.length, version: state.version, checksum: checksum(evidence) };
        eventSink?.({ event_type: "agent.activity", conversation_id: conversationId, payload: { activity_type: "subagent_completed", agent_type: "subagent", status: "success", subagent_id: workerId, parent_agent_id: parentAgentId, delegation_id: delegationId, evidence_count: evidence.length } });
        return worker.result;
      });
    },
    snapshot({ conversationId, delegationId } = {}) {
      const state = stateFor(conversationId, delegationId);
      return { conversation_id: state.conversation_id, delegation_id: state.delegation_id, version: state.version, workers: [...state.workers.values()], evidence: [...state.evidence.values()] };
    },
    release({ conversationId, delegationId } = {}) {
      delegations.delete(delegationKey(conversationId, delegationId));
    }
  });
}
