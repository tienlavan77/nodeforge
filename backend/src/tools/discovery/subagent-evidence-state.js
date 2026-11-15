// Business purpose: keeps shared evidence durable across concurrent project processes.
// Technical description: owns scoped state, filesystem transaction locking and atomic snapshot publication.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
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
        initial.durability_errors = parsed.durability_errors ?? [];
        initial.last_durability_error = initial.durability_errors.at(-1) ?? null;
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
// Business purpose: publishes durable evidence snapshots without exposing partially written state to another role or process.
// Technical description: serializes to a unique sibling temporary file and atomically renames it into place after the complete snapshot is written.
function persistRoleState(state, scope = {}) {
  if (!state?.filePath) return false;
  let releaseLock;
  let temporary;
  try {
    releaseLock = acquirePersistenceLock(state.filePath);
    const currentPayload = {
      project_id: state.project_id,
      role: state.role,
      version: state.version,
      updated_at: new Date().toISOString(),
      scopes: [...state.scopes],
      workers: [...state.workers.values()],
      evidence: [...state.evidence.values()],
      durability_errors: state.durability_errors ?? []
    };
    let payload = currentPayload;
    if (existsSync(state.filePath)) {
      const persisted = JSON.parse(readFileSync(state.filePath, "utf8"));
      const evidenceByPath = new Map((persisted.evidence ?? []).map((entry) => [entry.path, entry]));
      for (const entry of currentPayload.evidence) {
        const previous = evidenceByPath.get(entry.path);
        if (!previous) { evidenceByPath.set(entry.path, entry); continue; }
        const attempts = new Map();
        for (const attempt of [...(previous.attempts ?? []), ...(entry.attempts ?? [])]) {
          if (attempt?.attempt_id) attempts.set(attempt.attempt_id, attempt);
        }
        const latest = (entry.updated_at ?? "") >= (previous.updated_at ?? "") ? entry : previous;
        const sameSource = previous.sha256 === entry.sha256;
        evidenceByPath.set(entry.path, {
          ...previous, ...latest, attempts: [...attempts.values()],
          ...(sameSource ? { symbols_read: [...new Set([...(previous.symbols_read ?? []), ...(entry.symbols_read ?? [])])] } : {})
        });
      }
      const workersById = new Map();
      for (const worker of [...(persisted.workers ?? []), ...currentPayload.workers]) {
        const identity = worker.worker_id ?? worker.delegation_id ?? JSON.stringify(worker);
        const previous = workersById.get(identity);
        if (!previous || (worker.heartbeat_at ?? "") > (previous.heartbeat_at ?? "")
          || ((worker.heartbeat_at ?? "") === (previous.heartbeat_at ?? "") && worker.result && !previous.result)) workersById.set(identity, worker);
      }
      payload = {
        ...persisted,
        ...currentPayload,
        version: Math.max(Number(persisted.version) || 0, Number(currentPayload.version) || 0) + 1,
        scopes: [...new Set([...(persisted.scopes ?? []), ...currentPayload.scopes])],
        durability_errors: [...new Map([...(persisted.durability_errors ?? []), ...currentPayload.durability_errors].map((error) => [JSON.stringify(error), error])).values()],
        workers: [...workersById.values()],
        evidence: [...evidenceByPath.values()]
      };
    }
    const snapshot = JSON.stringify(payload, null, 2);
    temporary = state.filePath + ".tmp-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    writeFileSync(temporary, snapshot, "utf8");
    renameSync(temporary, state.filePath);
    state.version = payload.version;
    state.evidence = new Map(payload.evidence.map((entry) => [entry.path, entry]));
    return true;
  } catch (error) {
    recordDurabilityError(state, "write", state.filePath, error, scope);
    return false;
  } finally {
    try { if (temporary && existsSync(temporary)) rmSync(temporary); }
    catch (error) { recordDurabilityError(state, "cleanup", temporary, error, scope); }
    try { releaseLock?.(); }
    catch (error) { recordDurabilityError(state, "unlock", state.filePath, error, scope); }
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

// Business purpose: prevents lost evidence across independent Node processes.
// Technical description: an exclusive filesystem directory covers the entire read/merge/rename
// transaction. A bounded wait fails closed; abandoned locks are never stolen from a live writer.
function acquirePersistenceLock(filePath) {
  const lockPath = filePath + ".lock";
  const deadline = Date.now() + 10000;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      mkdirSync(lockPath);
      return () => rmSync(lockPath, { recursive: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw Object.assign(new Error("Evidence persistence lock timed out"), { code: "EVIDENCE_LOCK_TIMEOUT" });
      }
      Atomics.wait(signal, 0, 0, 10);
    }
  }
}

export { checksum, delegationKey, delegations, inferPlanAndHandoff, persistRoleState, roleStateFor, scopeTokens, stateFor, withLock };
