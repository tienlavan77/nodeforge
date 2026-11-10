// Business purpose: provides a durable per-agent evidence store for AM, SE, RV, and Coder with cross-role sharing across AM <-> SE <-> RV handoffs and Sprint/Ticket flows.
// Technical description: combines an in-memory map with durable JSON persistence under .forge/runtime/nf/evidence-stores/<projectId>/, tracking subagent workers, direct parent reads, and file mutations.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROLE_ALIASES = Object.freeze({ am: "architecture_manager", architecture: "architecture_manager", architecture_manager: "architecture_manager", se: "system_engineer", "system-engineer": "system_engineer", system_engineer: "system_engineer", rv: "reviewer", reviewer: "reviewer", coder: "coder", sl: "sprint_leader", sprint_leader: "sprint_leader" });
const delegations = new Map();
const roleStores = new Map();
const locks = new Map();

// Business purpose: builds a deterministic composite key for in-memory delegation state isolation.
// Technical description: concatenates scopeType, conversationId, and delegationId with fallback defaults.
const delegationKey = (conversationId, delegationId, scopeType = "owner") => `${scopeType}:${conversationId ?? "unknown"}:${delegationId ?? "default"}`;

// Business purpose: computes a content hash over serialized evidence entries for integrity verification.
// Technical description: returns a hex-encoded SHA-256 digest of the JSON-serialized payload.
const checksum = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Business purpose: sanitizes untrusted identifiers for safe filesystem directory and filename construction.
// Technical description: replaces non-alphanumeric characters outside [A-Za-z0-9_.-] with underscores and caps length at 80 chars.
const safeSegment = (value) => String(value ?? "default").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "default";

// Business purpose: records and logs durability failures so persistence errors are never silently discarded.
// Technical description: appends structured error metadata to the role store state and emits a warning event to projectLogger or eventSink.
function recordDurabilityError(targetState, operation, filePath, error, { projectLogger, eventSink, conversationId } = {}) {
  const entry = {
    operation,
    file_path: filePath ?? null,
    message: String(error?.message ?? error ?? "Durability operation failed."),
    code: error?.code ?? "EVIDENCE_DURABILITY_ERROR",
    timestamp: new Date().toISOString()
  };
  if (targetState) {
    targetState.durability_errors = Array.isArray(targetState.durability_errors) ? targetState.durability_errors : [];
    targetState.durability_errors.push(entry);
    targetState.last_durability_error = entry;
  }
  projectLogger?.({
    event_name: "subagent_evidence.durability_error",
    level: "warn",
    status: "error",
    message: `Subagent evidence store ${operation} failed: ${entry.message}`,
    conversation_id: conversationId ?? null,
    source: "subagent-evidence-store",
    payload: entry
  });
  eventSink?.({
    event_type: "subagent_evidence.durability_error",
    conversation_id: conversationId ?? null,
    payload: entry
  });
  return entry;
}

// Business purpose: normalizes role identifiers to canonical NodeForge role keys.
// Technical description: maps short role codes and hyphenated variants to canonical snake_case role names.
function normalizeRole(role, conversationId) {
  if (typeof role === "string" && ROLE_ALIASES[role.toLowerCase()]) return ROLE_ALIASES[role.toLowerCase()];
  const conv = String(conversationId ?? "");
  return conv.startsWith("CONV-SE-") ? "system_engineer" : conv.startsWith("CONV-RV-") ? "reviewer" : "architecture_manager";
}

// Business purpose: derives planId or handoffId from conversation or delegation identifiers when not explicitly supplied.
// Technical description: parses CONV-SE-<planId>, CONV-RV-<planId>, and HANDOFF-<planId>-R<n> patterns.
function inferPlanAndHandoff({ conversationId, linkedConversationId, handoffId, planId, delegationId } = {}) {
  let resolvedPlanId = planId ?? null;
  let resolvedHandoffId = handoffId ?? null;
  for (const candidate of [conversationId, linkedConversationId, delegationId, handoffId]) {
    const text = String(candidate ?? "");
    const convMatch = !resolvedPlanId ? /^CONV-(?:SE|RV)-(.+)$/.exec(text) : null;
    if (convMatch) resolvedPlanId = convMatch[1];
    const handoffMatch = /^HANDOFF-(.+)-R\d+$/i.exec(text) ?? /^handoff:.*:(HANDOFF-(.+)-R\d+)$/i.exec(text);
    if (handoffMatch) {
      if (!resolvedHandoffId) resolvedHandoffId = handoffMatch[2] ? handoffMatch[1] : text;
      if (!resolvedPlanId) resolvedPlanId = handoffMatch[2] ?? handoffMatch[1];
    }
  }
  return { planId: resolvedPlanId, handoffId: resolvedHandoffId };
}

// Business purpose: resolves the durable evidence directory path for a project.
// Technical description: creates .forge/runtime/nf/evidence-stores/<projectId> inside projectRoot when available.
function resolveStoreFilePath({ projectRoot, projectId, role, onDurabilityError }) {
  if (!projectRoot && !projectId) return null;
  const root = projectRoot ? resolve(projectRoot) : process.cwd();
  const pid = safeSegment(projectId ?? (projectRoot ? basename(resolve(projectRoot)) : "default"));
  const dir = join(root, ".forge", "runtime", "nf", "evidence-stores", pid);
  try {
    mkdirSync(dir, { recursive: true });
    return join(dir, `${safeSegment(role)}.json`);
  } catch (error) {
    onDurabilityError?.("mkdir", dir, error);
    return null;
  }
}

// Business purpose: retrieves or initializes a durable role store in memory and loads existing disk state.
// Technical description: maintains workers, file evidence, and scope links keyed by project and role.
function roleStateFor(scope = {}) {
  const role = normalizeRole(scope.role, scope.conversationId);
  const pid = safeSegment(scope.projectId ?? (scope.projectRoot ? basename(resolve(scope.projectRoot)) : "default"));
  const key = `${pid}:${role}`;
  if (!roleStores.has(key)) {
    const initial = { project_id: pid, role, version: 0, workers: new Map(), evidence: new Map(), scopes: new Set(), durability_errors: [], last_durability_error: null };
    const onDurabilityError = (op, targetPath, err) => recordDurabilityError(initial, op, targetPath, err, scope);
    const filePath = resolveStoreFilePath({ projectRoot: scope.projectRoot, projectId: pid, role, onDurabilityError });
    if (filePath && existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
        initial.version = Number(parsed.version ?? 0);
        initial.workers = new Map((parsed.workers ?? []).map((w) => [w.worker_id, w]));
        initial.evidence = new Map((parsed.evidence ?? []).map((e) => [e.path, e]));
        initial.scopes = new Set(parsed.scopes ?? []);
      } catch (error) {
        onDurabilityError("read_parse", filePath, error);
      }
    }
    roleStores.set(key, { ...initial, filePath });
  }
  const state = roleStores.get(key);
  if (!state.filePath && (scope.projectRoot || scope.projectId)) {
    state.filePath = resolveStoreFilePath({
      projectRoot: scope.projectRoot,
      projectId: pid,
      role,
      onDurabilityError: (op, targetPath, err) => recordDurabilityError(state, op, targetPath, err, scope)
    });
  }
  return state;
}

// Business purpose: persists the current role store snapshot to disk under .forge/runtime/nf/evidence-stores/<projectId>/.
// Technical description: serializes workers, evidence, and linked scopes into JSON when a project file path is available.
function persistRoleState(state, scope = {}) {
  if (!state?.filePath) return false;
  try {
    writeFileSync(state.filePath, JSON.stringify({ project_id: state.project_id, role: state.role, version: state.version, updated_at: new Date().toISOString(), scopes: [...state.scopes], workers: [...state.workers.values()], evidence: [...state.evidence.values()] }, null, 2), "utf8");
    return true;
  } catch (error) {
    recordDurabilityError(state, "write", state.filePath, error, scope);
    return false;
  }
}

// Business purpose: retrieves one conversation delegation record so workers share evidence without crossing unrelated conversations.
// Technical description: lazily creates versioned worker and evidence maps keyed by conversation and delegation.
function stateFor(conversationId, delegationId) {
  const id = delegationKey(conversationId, delegationId);
  if (!delegations.has(id)) delegations.set(id, { conversation_id: conversationId ?? null, delegation_id: delegationId ?? null, version: 0, workers: new Map(), evidence: new Map() });
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

// Business purpose: collects scope tokens linking conversations, plans, handoffs, and tickets for cross-role sharing.
// Technical description: normalizes non-empty scope identifiers into tagged strings.
function scopeTokens(scope = {}) {
  const { planId, handoffId } = inferPlanAndHandoff(scope);
  const tokens = [];
  if (scope.conversationId) tokens.push(`conv:${scope.conversationId}`);
  if (scope.linkedConversationId) tokens.push(`conv:${scope.linkedConversationId}`);
  if (planId) tokens.push(`plan:${planId}`, `conv:CONV-SE-${planId}`, `conv:CONV-RV-${planId}`);
  if (handoffId) tokens.push(`handoff:${handoffId}`);
  if (scope.ticketId) tokens.push(`ticket:${scope.ticketId}`);
  return tokens;
}

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
        const durable = persistRoleState(roleState, input);
        worker.result = { status, fallback_to_parent: status === "fallback_to_parent", summary, usage, evidence_count: evidence.length, version: nextVersion, checksum: checksum(evidence), durable, ...(roleState.last_durability_error && !durable ? { durability_error: roleState.last_durability_error } : {}) };
        state.workers.set(workerId, worker); roleState.workers.set(workerId, worker);
        eventSink?.({ event_type: "agent.activity", conversation_id: conversationId, payload: { agent_id: workerId, activity_type: isFallback ? "tool_failed" : "tool_completed", agent_type: "subagent", status: isFallback ? "failed" : "success", summary: `[subagent:${String(workerId ?? "subagent").split(":sub:").at(-1)}] ${isFallback ? "fallback_to_parent" : `completed (${evidence.length} files observed)`}`, tool_name: "delegate_subagent", subagent_id: workerId, parent_agent_id: parentAgentId, delegation_id: delegationId, evidence_count: evidence.length, durable } });
        return worker.result;
      });
    },
    recordCandidateReceipt(input = {}) {
      const { path, sha256 = null, retrieval_id: retrievalId = null, source = "ticket", matched_ac: matchedAc = [], matched_intents: matchedIntents = [], matched_symbols: matchedSymbols = [], score = null, confidence = null, reasons = [] } = input;
      if (!path || typeof path !== "string") return null;
      const state = stateFor(input.conversationId, input.delegationId);
      const roleState = roleStateFor({ ...input, projectRoot: input.projectRoot ?? defaultProjectRoot, projectId: input.projectId ?? defaultProjectId });
      for (const token of scopeTokens(input)) roleState.scopes.add(token);
      const nextVersion = Math.max(state.version, roleState.version) + 1;
      state.version = nextVersion; roleState.version = nextVersion;
      const prev = roleState.evidence.get(path) ?? state.evidence.get(path);
      const shaChanged = Boolean(sha256 && prev?.sha256 && prev.sha256 !== sha256);
      const { planId, handoffId } = inferPlanAndHandoff(input);
      const relevance = {
        retrieval_id: retrievalId ?? `RETRIEVAL-${nextVersion}`,
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
      const { path, sha256, total_lines: totalLines, symbol_map: symbolMap, code_graph: codeGraph, symbols_read: symbolsRead = [], source_tool: sourceTool = "read_file", deleted = false, from_path: fromPath = null } = input;
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
      const prevTools = !shaChanged && Array.isArray(prev?.provenance?.source_tools) ? prev.provenance.source_tools : [];
      const entry = {
        ...(shaChanged ? {} : prev),
        path, sha256,
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
        ...(!shaChanged && prev?.relevance ? { relevance: prev.relevance } : {}),
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
