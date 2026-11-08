// Business purpose: lets Architecture Manager, System Engineer, and Reviewer reuse verified discoveries from parallel workers before searching the workspace again.
// Technical description: exposes a bounded read-only snapshot of the in-memory evidence store for one conversation and delegation, preserving worker identity, checksums, symbols, and graph metadata without source bytes.

export const subagentEvidenceDefinition = Object.freeze({
  name: "read_subagent_evidence",
  description: "Read bounded shared evidence and worker status for a conversation delegation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      conversation_id: { type: "string", minLength: 1 },
      delegation_id: { type: "string", minLength: 1 }
    },
    required: []
  }
});

// Business purpose: gives governed agents one consistent entry point to reuse parallel discovery.
// Technical description: validates the injected store, selects the requested delegation, and returns only bounded metadata and worker lifecycle state.
export function createSubagentEvidenceTool({ evidenceStore } = {}) {
  if (typeof evidenceStore?.snapshot !== "function") throw new Error("read_subagent_evidence requires an evidence store.");
  return {
    definition: subagentEvidenceDefinition,
    async execute(input = {}, context = {}) {
      const conversationId = String(context.evidence_scope?.conversationId ?? context.conversation_id ?? "");
      const delegationId = String(context.evidence_scope?.delegationId ?? context.execution_id ?? context.task_id ?? "");
      if ((input.conversation_id && input.conversation_id !== conversationId) || (input.delegation_id && input.delegation_id !== delegationId)) {
        throw Object.assign(new Error("Evidence access is restricted to the runtime-bound execution scope."), { code: "EVIDENCE_SCOPE_FORBIDDEN" });
      }
      if (!conversationId || !delegationId) throw new Error("conversation_id and delegation_id are required.");
      const snapshot = evidenceStore.snapshot({ conversationId, delegationId });
      return {
        conversation_id: snapshot.conversation_id,
        delegation_id: snapshot.delegation_id,
        version: snapshot.version,
        workers: snapshot.workers.map(({ worker_id, parent_agent_id, agent_type, objective, status, heartbeat_at, result }) => ({ worker_id, parent_agent_id, agent_type, objective, status, heartbeat_at, result })),
        evidence: snapshot.evidence.map(({ path, sha256, symbols, symbol_map, source_worker_id, delegation_id: sourceDelegation, version }) => ({ path, sha256, symbols, symbol_map, source_worker_id, delegation_id: sourceDelegation, version }))
      };
    }
  };
}