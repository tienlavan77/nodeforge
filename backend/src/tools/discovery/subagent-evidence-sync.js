// Business purpose: synchronizes direct parent tool invocations (read_file, Read, write_diff, edit_diff, delete_file, move_file) into the durable per-agent subagent evidence store.
// Technical description: extracts file path, sha256, line count, symbol map, code graph, and read symbols from tool inputs and results, updating the shared evidence store.
import { extractOwnerResultChecksum, extractOwnerToolPathMeta } from "../../application/owner-context-compaction.js";
import { createSubagentEvidenceStore } from "./subagent-evidence-store.js";
import { candidateSourceMetadata } from "./candidate-source-receipts.js";

export const sharedSubagentEvidenceStore = createSubagentEvidenceStore();

// Business purpose: records a completed parent read or mutation tool call into the durable evidence store.
// Technical description: normalizes scope metadata from the tool execution context and updates or removes the file entry in the evidence store.
export function syncToolResultToEvidenceStore({ toolName, input = {}, result = {}, context = {}, evidenceStore = sharedSubagentEvidenceStore, projectRoot = null } = {}) {
  if (!evidenceStore || typeof evidenceStore.recordDirectEvidence !== "function") return null;
  if (!["read_file", "Read", "select_code_graph_candidates", "write_diff", "edit_diff", "delete_file", "move_file"].includes(toolName)) return null;
  const scope = context?.evidence_scope ?? {};
  const scopeContext = {
    projectId: scope.projectId ?? context?.project_id ?? null,
    projectRoot: projectRoot ?? scope.projectRoot ?? context?.project_root ?? null,
    role: scope.role ?? context?.agent_identity?.role ?? null,
    conversationId: scope.conversationId ?? context?.conversation_id ?? context?.task_id ?? null,
    linkedConversationId: scope.linkedConversationId ?? null,
    handoffId: scope.handoffId ?? null,
    planId: scope.planId ?? null,
    ticketId: scope.ticketId ?? context?.task_id ?? null,
    delegationId: scope.delegationId ?? context?.execution_id ?? context?.task_id ?? null,
    workerId: context?.agent_identity?.agent_id ? `parent:${context.agent_identity.agent_id}` : undefined
  };
  if (toolName === "select_code_graph_candidates") {
    return (result.selected ?? []).map((entry) => {
      const metadata = candidateSourceMetadata(entry, context);
      if (!metadata || entry.evidence?.status !== "not_recorded") return null;
      try {
        const stored = evidenceStore.recordDirectEvidence({ ...scopeContext, ...metadata, correlation_id: metadata.receipt_id, symbols_read: [], source_tool: toolName,
          relevance: { score: entry.score ?? null, semantic_score: entry.semantic_score ?? null,
            lexical_score: entry.lexical_score ?? null, relations: entry.relations ?? [],
            matched_symbols: entry.matched_symbols ?? [], matched_ac: entry.matched_ac ?? [],
            matched_intents: entry.matched_intents ?? [], reasons: entry.reasons ?? entry.reason ?? [],
            confidence: entry.confidence ?? null, recorded_at: new Date().toISOString() },
          workerId: scopeContext.workerId ?? `parent:${scopeContext.role ?? "candidate"}` });
        entry.evidence = stored?.durable === true
          ? { status: "recorded", durable: true }
          : { status: "failed", durable: false, error: stored?.durability_error ?? "Evidence persistence is unavailable." };
        if (!entry.evidence.durable) console.warn("Candidate evidence persistence failed.", { path: metadata.path, error: entry.evidence.error });
        return stored;
      } catch (error) {
        entry.evidence = { status: "failed", durable: false, error: String(error.message ?? error) };
        console.warn("Candidate evidence persistence failed.", { path: metadata.path, error: entry.evidence.error });
        return null;
      }
    });
  }
  const stepMeta = extractOwnerToolPathMeta(toolName, input);
  if (toolName === "delete_file") {
    return evidenceStore.recordDirectEvidence({ ...scopeContext, path: stepMeta.path ?? input?.path, deleted: true, source_tool: toolName });
  }
  const { sha256, totalLines } = extractOwnerResultChecksum({ tool_name: toolName, ...stepMeta }, result);
  const targetPath = stepMeta.to_path ?? stepMeta.path ?? result?.path ?? result?.file_path;
  if (!targetPath || !sha256) return null;
  const symbolsRead = toolName === "Read" && typeof input?.symbol === "string" && input.symbol
    ? [input.symbol]
    : Array.isArray(result?.observed_file?.symbols_read)
      ? result.observed_file.symbols_read
      : [];
  return evidenceStore.recordDirectEvidence({
    ...scopeContext,
    path: targetPath,
    from_path: stepMeta.from_path ?? null,
    sha256,
    total_lines: totalLines,
    symbol_map: Array.isArray(result?.symbol_map) ? result.symbol_map : undefined,
    code_graph: result?.code_graph ?? undefined,
    symbols_read: symbolsRead,
    source_tool: toolName
  });
}
