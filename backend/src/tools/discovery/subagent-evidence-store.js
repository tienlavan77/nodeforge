// Business purpose: provides a durable per-agent evidence store for AM, SE, RV, and Coder with cross-role sharing across AM <-> SE <-> RV handoffs and Sprint/Ticket flows.
// Technical description: combines an in-memory map with durable JSON persistence under .forge/runtime/nf/evidence-stores/<projectId>/, tracking subagent workers, direct parent reads, and file mutations.
import { randomUUID } from "node:crypto";
import { checksum, delegationKey, delegations, inferPlanAndHandoff, persistRoleState, roleStateFor, scopeTokens, stateFor, withLock } from "./subagent-evidence-state.js";

// Business purpose: exposes worker lifecycle and shared durable evidence to AM, SE, RV, and Coder agents.
// Technical description: records worker state, direct parent reads, and file mutations while supporting cross-role merging across AM <-> SE <-> RV and Coder ticket scopes.
export function createSubagentEvidenceStore({ projectRoot: defaultProjectRoot = null, projectId: defaultProjectId = null } = {}) {
  return Object.freeze({
    startWorker(input = {}) {
      const { conversationId, delegationId, workerId, parentAgentId = null, objective, eventSink } = input;
      const state = stateFor(conversationId, delegationId);
      const roleState = roleStateFor({ ...input, projectRoot: input.projectRoot ?? defaultProjectRoot, projectId: input.projectId ?? defaultProjectId });
      const worker = { worker_id: workerId, parent_agent_id: parentAgentId, role: roleState.role, agent_type: "subagent", objective, status: "running", heartbeat_at: new Date().toISOString(), result: null };
      state.workers.set(workerId, worker);
      roleState.workers.set(workerId, worker);
      for (const token of scopeTokens(input)) roleState.scopes.add(token);
      persistRoleState(roleState, input);
      eventSink?.({ event_type: "agent.activity", conversation_id: conversationId, payload: { agent_id: workerId, activity_type: "tool_started", agent_type: "subagent", status: "working", summary: `[subagent:${String(workerId ?? "subagent").split(":sub:").at(-1)}] ${String(objective ?? "Exploring repository").slice(0, 240)}`, tool_name: "delegate_subagent", subagent_id: workerId, parent_agent_id: parentAgentId, delegation_id: delegationId } });
    },
    heartbeat({ conversationId, delegationId, workerId } = {}) {
      const worker = stateFor(conversationId, delegationId).workers.get(workerId);
      if (worker) worker.heartbeat_at = new Date().toISOString();
    },
    async complete(input = {}) {
      const { conversationId, delegationId, workerId, parentAgentId = null, status = "completed", summary = "", observedFiles = [], usage = null, eventSink } = input;
      return withLock(delegationKey(conversationId, delegationId), async () => {
        const state = stateFor(conversationId, delegationId);
        const roleState = roleStateFor({ ...input, projectRoot: input.projectRoot ?? defaultProjectRoot, projectId: input.projectId ?? defaultProjectId });
        for (const token of scopeTokens(input)) roleState.scopes.add(token);
        const worker = state.workers.get(workerId) ?? roleState.workers.get(workerId) ?? { worker_id: workerId, parent_agent_id: parentAgentId, role: roleState.role, agent_type: "subagent" };
        const nextVersion = Math.max(state.version, roleState.version) + 1;
        const { planId, handoffId } = inferPlanAndHandoff(input);
        const nowIso = new Date().toISOString();
        const isFallback = status === "fallback_to_parent";
        const evidence = observedFiles.filter((file) => file?.path && file?.sha256).map((file) => ({
          path: file.path, sha256: file.sha256,
          ...(Number.isInteger(file.total_lines) ? { total_lines: file.total_lines } : {}),
          ...(Array.isArray(file.symbols) ? { symbols: file.symbols } : {}),
          ...(Array.isArray(file.symbol_map) ? { symbol_map: file.symbol_map } : {}),
          ...(file.code_graph ? { code_graph: file.code_graph } : {}),
          symbols_read: [...new Set(file.symbols_read ?? [])],
          parent_execution_id: file.parent_execution_id ?? input.parentExecutionId ?? delegationId ?? null,
          child_execution_id: file.child_execution_id ?? `${delegationId ?? "delegation"}:sub:${workerId}`,
          child_agent_id: file.child_agent_id ?? workerId,
          source_tool: file.source_tool ?? "read_file",
          observed_at: file.observed_at ?? nowIso,
          read_only_enforced: true,
          provenance: {
            delegation_id: delegationId ?? null,
            parent_execution_id: file.parent_execution_id ?? input.parentExecutionId ?? delegationId ?? null,
            child_execution_id: file.child_execution_id ?? `${delegationId ?? "delegation"}:sub:${workerId}`,
            child_agent_id: file.child_agent_id ?? workerId,
            source_worker_id: workerId,
            source_role: roleState.role,
            source_tools: [file.source_tool ?? "read_file"],
            observed_at: file.observed_at ?? nowIso,
            read_only_enforced: true,
            ...(isFallback ? { fallback_to_parent: true } : {})
          },
          source_worker_id: workerId, source_role: roleState.role, conversation_id: conversationId ?? null, delegation_id: delegationId ?? null, plan_id: planId, handoff_id: handoffId, updated_at: nowIso, version: nextVersion
        }));
        for (const item of evidence) {
          const prev = roleState.evidence.get(item.path) ?? state.evidence.get(item.path);
          const shaChanged = prev && prev.sha256 !== item.sha256;
          const mergedEntry = {
            ...(shaChanged ? {} : prev),
            ...item,
            symbols_read: [...new Set([...(shaChanged ? [] : prev?.symbols_read ?? []), ...(item.symbols_read ?? [])])],
            ...(item.symbol_map ? { symbol_map: item.symbol_map } : (!shaChanged && prev?.symbol_map ? { symbol_map: prev.symbol_map } : {})),
            ...(!shaChanged && prev?.relevance ? { relevance: prev.relevance } : {})
          };
          state.evidence.set(item.path, mergedEntry);
          roleState.evidence.set(item.path, mergedEntry);
        }
        state.version = nextVersion; roleState.version = nextVersion;
        worker.status = status; worker.heartbeat_at = new Date().toISOString();
        worker.result = { status, fallback_to_parent: status === "fallback_to_parent", summary, usage, evidence_count: evidence.length, version: nextVersion, checksum: checksum(evidence), durable: true };
        state.workers.set(workerId, worker); roleState.workers.set(workerId, worker);
        const durable = persistRoleState(roleState, input);
        worker.result = { ...worker.result, durable, ...(roleState.last_durability_error && !durable ? { durability_error: roleState.last_durability_error } : {}) };
        eventSink?.({ event_type: "agent.activity", conversation_id: conversationId, payload: { agent_id: workerId, activity_type: isFallback ? "tool_failed" : "tool_completed", agent_type: "subagent", status: isFallback ? "failed" : "success", summary: `[subagent:${String(workerId ?? "subagent").split(":sub:").at(-1)}] ${isFallback ? "fallback_to_parent" : `completed (${evidence.length} files observed)`}`, tool_name: "delegate_subagent", subagent_id: workerId, parent_agent_id: parentAgentId, delegation_id: delegationId, evidence_count: evidence.length, durable } });
        return worker.result;
      });
    },
    recordCandidateReceipt(input = {}) {
      const { path, sha256 = null, retrieval_id: retrievalId = null, attempt_id: attemptId = null, source = "ticket", matched_ac: matchedAc = [], matched_intents: matchedIntents = [], matched_symbols: matchedSymbols = [], score = null, confidence = null, reasons = [] } = input;
      if (!path || typeof path !== "string") return null;
      const state = stateFor(input.conversationId, input.delegationId);
      const roleState = roleStateFor({ ...input, projectRoot: input.projectRoot ?? defaultProjectRoot, projectId: input.projectId ?? defaultProjectId });
      for (const token of scopeTokens(input)) roleState.scopes.add(token);
      const nextVersion = Math.max(state.version, roleState.version) + 1;
      state.version = nextVersion; roleState.version = nextVersion;
      const prev = roleState.evidence.get(path) ?? state.evidence.get(path);
      const shaChanged = Boolean(sha256 && prev?.sha256 && prev.sha256 !== sha256);
      const { planId, handoffId } = inferPlanAndHandoff(input);
      const attemptIdentity = attemptId ?? input.attemptId ?? `${retrievalId ?? `RETRIEVAL-${nextVersion}`}:attempt:${randomUUID()}`;
      const relevance = {
        retrieval_id: retrievalId ?? `RETRIEVAL-${nextVersion}`,
        attempt_id: attemptIdentity,
        source,
        matched_ac: [...new Set(Array.isArray(matchedAc) ? matchedAc : [])],
        matched_intents: [...new Set(Array.isArray(matchedIntents) ? matchedIntents : [])],
        matched_symbols: Array.isArray(matchedSymbols) ? matchedSymbols : [],
        ...(typeof score === "number" ? { score } : {}),
        ...(confidence ? { confidence } : {}),
        reasons: [...new Set(Array.isArray(reasons) ? reasons : [])],
        recorded_at: new Date().toISOString()
      };
      const entry = {
        ...(shaChanged ? { path } : prev ?? { path }),
        path,
        ...(sha256 ? { sha256 } : prev?.sha256 ? { sha256: prev.sha256 } : {}),
        relevance,
        // Preserve every retrieval attempt while keeping the latest entry addressable by path.
        attempts: [...(prev?.attempts ?? []), { attempt_id: attemptIdentity, retrieval_id: relevance.retrieval_id, source, sha256: sha256 ?? prev?.sha256 ?? null, relevance, recorded_at: relevance.recorded_at }],
        conversation_id: input.conversationId ?? prev?.conversation_id ?? null,
        delegation_id: input.delegationId ?? prev?.delegation_id ?? null,
        plan_id: planId ?? prev?.plan_id ?? null,
        handoff_id: handoffId ?? prev?.handoff_id ?? null,
        updated_at: new Date().toISOString(),
        version: nextVersion
      };
      state.evidence.set(path, entry); roleState.evidence.set(path, entry);
      const durable = persistRoleState(roleState, input);
      return { ...entry, durable, ...(roleState.last_durability_error && !durable ? { durability_error: roleState.last_durability_error } : {}) };
    },
    recordDirectEvidence(input = {}) {
      const { path, sha256, total_lines: totalLines, symbol_map: symbolMap, code_graph: codeGraph, symbols_read: symbolsRead = [], source_tool: sourceTool = "read_file", deleted = false, from_path: fromPath = null, correlation_id: correlationId = null, attempt_id: attemptId = null } = input;
      const state = stateFor(input.conversationId, input.delegationId);
      const roleState = roleStateFor({ ...input, projectRoot: input.projectRoot ?? defaultProjectRoot, projectId: input.projectId ?? defaultProjectId });
      for (const token of scopeTokens(input)) roleState.scopes.add(token);
      if (fromPath) { state.evidence.delete(fromPath); roleState.evidence.delete(fromPath); }
      if (deleted && path) { state.evidence.delete(path); roleState.evidence.delete(path); persistRoleState(roleState, input); return null; }
      if (!path || !sha256) return null;
      const nextVersion = Math.max(state.version, roleState.version) + 1;
      state.version = nextVersion; roleState.version = nextVersion;
      const prev = roleState.evidence.get(path) ?? state.evidence.get(path);
      const shaChanged = prev && prev.sha256 !== sha256;
      const resolvedSymbolMap = Array.isArray(symbolMap) ? symbolMap : (!shaChanged ? prev?.symbol_map : undefined);
      const symbolNames = Array.isArray(resolvedSymbolMap) ? [...new Set(resolvedSymbolMap.map((s) => s?.name).filter(Boolean))] : (!shaChanged ? prev?.symbols : undefined);
      const { planId, handoffId } = inferPlanAndHandoff(input);
      const nowIso = new Date().toISOString();
      const workerId = input.workerId ?? prev?.source_worker_id ?? `parent:${roleState.role}`;
      const attemptIdentity = attemptId ?? input.attemptId ?? correlationId ?? `${sourceTool}:${randomUUID()}`;
      const prevTools = !shaChanged && Array.isArray(prev?.provenance?.source_tools) ? prev.provenance.source_tools : [];
      const entry = {
        ...(shaChanged ? {} : prev),
        path, sha256,
        ...(correlationId ? { correlation_id: correlationId } : !shaChanged && prev?.correlation_id ? { correlation_id: prev.correlation_id } : {}),
        ...(Number.isInteger(totalLines ?? prev?.total_lines) ? { total_lines: totalLines ?? prev?.total_lines } : {}),
        ...(symbolNames?.length ? { symbols: symbolNames } : {}),
        ...(Array.isArray(resolvedSymbolMap) ? { symbol_map: resolvedSymbolMap } : {}),
        ...(codeGraph ? { code_graph: codeGraph } : !shaChanged && prev?.code_graph ? { code_graph: prev.code_graph } : {}),
        symbols_read: [...new Set([...(shaChanged ? [] : prev?.symbols_read ?? []), ...symbolsRead])],
        observed_at: nowIso,
        read_only_enforced: Boolean(input.readOnlyEnforced ?? prev?.read_only_enforced ?? false),
        provenance: {
          ...(!shaChanged && prev?.provenance ? prev.provenance : {}),
          delegation_id: input.delegationId ?? prev?.delegation_id ?? null,
          parent_execution_id: input.parentExecutionId ?? input.delegationId ?? prev?.parent_execution_id ?? null,
          source_worker_id: workerId,
          source_role: roleState.role,
          source_tools: [...new Set([...prevTools, sourceTool])],
          observed_at: nowIso,
          read_only_enforced: Boolean(input.readOnlyEnforced ?? prev?.read_only_enforced ?? false)
        },
        ...(input.relevance ? { relevance: structuredClone(input.relevance) } : !shaChanged && prev?.relevance ? { relevance: prev.relevance } : {}),
        // Preserve the provenance and persistence outcome for each attempt on this path.
        attempts: [...(prev?.attempts ?? []), { attempt_id: attemptIdentity, correlation_id: correlationId, sha256, source_tool: sourceTool, relevance: input.relevance ? structuredClone(input.relevance) : null, observed_at: nowIso }],
        source_worker_id: workerId,
        source_role: roleState.role, source_tool: sourceTool, conversation_id: input.conversationId ?? prev?.conversation_id ?? null, delegation_id: input.delegationId ?? prev?.delegation_id ?? null, plan_id: planId ?? prev?.plan_id ?? null, handoff_id: handoffId ?? prev?.handoff_id ?? null, updated_at: nowIso, version: nextVersion
      };
      state.evidence.set(path, entry); roleState.evidence.set(path, entry);
      const durable = persistRoleState(roleState, input);
      return { ...entry, durable, ...(roleState.last_durability_error && !durable ? { durability_error: roleState.last_durability_error } : {}) };
    },
    snapshot(input = {}) {
      const { conversationId, delegationId } = input;
      const exact = stateFor(conversationId, delegationId);
      const roleState = roleStateFor({ ...input, projectRoot: input.projectRoot ?? defaultProjectRoot, projectId: input.projectId ?? defaultProjectId });
      const tokens = scopeTokens(input);
      const mergedWorkers = new Map(exact.workers);
      const mergedEvidence = new Map(exact.evidence);
      const durabilityErrors = [...(roleState.durability_errors ?? [])];
      let maxVersion = Math.max(exact.version, roleState.version);
      const pid = roleState.project_id;
      const shareRoles = ["architecture_manager", "system_engineer", "reviewer", "sprint_leader"].includes(roleState.role)
        ? ["architecture_manager", "system_engineer", "reviewer", "sprint_leader"]
        : ["coder", "architecture_manager", "sprint_leader", "system_engineer"];
      for (const candidateRole of shareRoles) {
        const candidateState = roleStateFor({ projectId: pid, projectRoot: input.projectRoot ?? defaultProjectRoot, role: candidateRole });
        const isOwnRole = candidateRole === roleState.role;
        if (!isOwnRole && tokens.length > 0 && candidateState.scopes.size > 0 && roleState.role !== "coder" && !tokens.some((t) => candidateState.scopes.has(t))) continue;
        if (!isOwnRole && Array.isArray(candidateState.durability_errors)) durabilityErrors.push(...candidateState.durability_errors);
        maxVersion = Math.max(maxVersion, candidateState.version);
        for (const [wid, w] of candidateState.workers) if (!mergedWorkers.has(wid)) mergedWorkers.set(wid, w);
        for (const [epath, item] of candidateState.evidence) {
          const existing = mergedEvidence.get(epath);
          if (!existing || (item.version ?? 0) >= (existing.version ?? 0)) {
            mergedEvidence.set(epath, { ...existing, ...item, symbols_read: [...new Set([...(existing?.symbols_read ?? []), ...(item.symbols_read ?? [])])], ...(item.symbol_map ? { symbol_map: item.symbol_map } : existing?.symbol_map ? { symbol_map: existing.symbol_map } : {}) });
          }
        }
      }
      return { conversation_id: conversationId ?? exact.conversation_id, delegation_id: delegationId ?? exact.delegation_id, role: roleState.role, version: maxVersion, workers: [...mergedWorkers.values()], evidence: [...mergedEvidence.values()], ...(durabilityErrors.length ? { durability_errors: durabilityErrors } : {}) };
    },
    release({ conversationId, delegationId } = {}) { delegations.delete(delegationKey(conversationId, delegationId)); }
  });
}
