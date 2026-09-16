import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { assertDiscoveryBudget, cloneExplorationState, createExplorationState, discoveryKind, markEditStarted } from "../../tools/exploration-state.js";

const TERMINAL_LIFECYCLES = new Set(["COMPLETED", "CANCELLED", "EXPIRED", "FAILED", "NEEDS_HUMAN_REVIEW"]);
const DEFAULT_MAX_BYTES = 200000;
const DEFAULT_MAX_CALLS = 20;
const DISCOVERY_TOOLS = new Set(["select_code_graph_candidates", "search_code", "read_file", "read_code"]);
const EDIT_TOOLS = new Set(["write_diff", "edit_diff"]);

// Runtime-owned authorization and retrieval accounting. The optional database
// adapter makes budget/audit state survive process restarts; memory is useful for
// isolated Tool Lab runs and remains deliberately scoped to one service instance.
export function createRuntimeToolGovernance({ database, eventStore, clock = () => new Date() } = {}) {
  if (database && (typeof database.run !== "function" || typeof database.all !== "function")) {
    throw new ConfigurationError("Runtime governance database requires run() and all().");
  }
  if (database) ensureTables(database);
  const contexts = new Map();
  const locks = new Map();
  const reservations = new Map();

  return Object.freeze({
    createExecutionContext,
    authorize,
    assertActive,
    reserveRetrieval,
    commitRetrieval,
    releaseRetrieval,
    audit,
    dispatch,
    getBudget
  });

  function createExecutionContext(input = {}) {
    const taskId = input.task_id ?? input.taskId;
    const scope = input.execution_scope ?? input.executionScope;
    const executionId = input.execution_id ?? input.executionId ?? scope?.execution_id ?? scope?.executionId;
    if (!isId(taskId) || !isId(executionId)) throw governanceError("TOOL_SCOPE_INVALID", "Runtime context requires task_id and execution_id.");
    if (!input.agent_identity) throw governanceError("TOOL_IDENTITY_INVALID", "Runtime context requires agent_identity.");
    const capabilities = [...new Set(input.capabilities ?? [])];
    const key = contextKey(taskId, executionId);
    const persisted = loadPersistedBudget(taskId, executionId);
    const budgetInput = persisted ?? input.retrieval_budget ?? input.context_budget ?? {};
    const budget = normalizeBudget(budgetInput);
    const explorationState = input.exploration_state ?? createExplorationState();
    if (Number.isInteger(input.discovery_budget) && input.discovery_budget > 0) explorationState.discovery_limit = input.discovery_budget;
    if (Number.isInteger(input.discovery_candidate_calls) && input.discovery_candidate_calls > 0) explorationState.candidate_limit = input.discovery_candidate_calls;
    if (Number.isInteger(input.discovery_search_calls) && input.discovery_search_calls > 0) explorationState.search_limit = input.discovery_search_calls;
    if (Number.isInteger(input.discovery_read_calls) && input.discovery_read_calls > 0) explorationState.read_limit = input.discovery_read_calls;
    if (Number.isInteger(input.discovery_edit_must_start_by) && input.discovery_edit_must_start_by > 0) explorationState.edit_must_start_by = input.discovery_edit_must_start_by;
    if (typeof input.discovery_target_path === "string" && input.discovery_target_path) explorationState.explicit_target = input.discovery_target_path;
    if (input.allow_discovery_escalation !== undefined) explorationState.allow_escalation = input.allow_discovery_escalation !== false;
    const context = {
      task_id: taskId,
      execution_id: executionId,
      execution_scope: normalizeScope(scope, taskId, executionId),
      agent_identity: input.agent_identity,
      // Mutated in place by write_diff/edit_diff (recordChangedPath) so
      // commit_changes can commit the files this execution actually wrote.
      changed_paths: Array.isArray(input.changed_paths) ? [...input.changed_paths] : [],
      capabilities,
      allowed_resources: input.allowed_resources ?? { allowed_file_paths: input.allowed_file_paths ?? [], allowed_prefixes: input.allowed_prefixes ?? [] },
      context_budget: budget,
      retrieval_budget: budget,
      lifecycle: input.lifecycle ?? "RUNNING",
      exploration_state: explorationState,
      verify_result: input.verify_result ?? input.verifyResult ?? null,
      audit_context: input.audit_context ?? {}
    };
    contexts.set(key, context);
    persistBudget(context);
    return cloneContext(context);
  }

  function authorize(toolName, context = {}, resource) {
    const normalized = resolveContext(context);
    assertActive(normalized);
    if (!normalized.capabilities.includes(toolName)) throw governanceError("TOOL_FORBIDDEN", `Agent is not authorized to use ${toolName}.`);
    for (const item of resourceList(resource)) if (!resourceAllowed(item, normalized.allowed_resources)) throw governanceError("TOOL_RESOURCE_FORBIDDEN", `Resource is outside the execution allowlist: ${item}.`);
    return true;
  }

  function assertActive(context = {}) {
    const lifecycle = String(context.lifecycle ?? "RUNNING").toUpperCase();
    if (TERMINAL_LIFECYCLES.has(lifecycle)) throw governanceError("TOOL_EXECUTION_INACTIVE", `Tool execution is not allowed while lifecycle is ${lifecycle}.`);
    return true;
  }

  async function reserveRetrieval(context, { tool, resource, estimatedBytes = 0 } = {}) {
    const normalized = resolveContext(context);
    authorize(tool, normalized, resource);
    const bytes = nonNegativeInteger(estimatedBytes, "estimatedBytes");
    return withLock(normalized, async () => {
      const budget = loadBudget(normalized);
      // Call accounting is per tool kind, not per invocation: the budget guards
      // against unbounded context growth (bytes), so a repeated read of the
      // same file does not consume a distinct call slot. distinct_calls() adds
      // this tool's name before reserving; commitRetrieval counts identically.
      if (budget.used_bytes + budget.reserved_bytes + bytes > budget.max_bytes || distinctCalls(budget, tool) > budget.max_calls) {
        throw governanceError("CONTEXT_BUDGET_EXCEEDED", `${tool} retrieval exceeds the current Context Budget.`);
      }
      budget.reserved_calls += 1;
      budget.reserved_bytes += bytes;
      persistBudgetValues(normalized, budget);
      const reservation = { task_id: normalized.task_id, execution_id: normalized.execution_id, reservation_id: randomUUID(), tool, resource, estimated_bytes: bytes };
      reservations.set(reservation.reservation_id, reservation);
      return reservation;
    });
  }

  function distinctCalls(budget, nextTool) {
    const names = new Set(budget.used_tool_calls ?? []);
    if (nextTool) names.add(nextTool);
    return names.size;
  }

  async function commitRetrieval(context, reservation, { bytes = reservation?.estimated_bytes ?? 0, success = true, error } = {}) {
    const normalized = resolveContext(context);
    const actualBytes = nonNegativeInteger(bytes, "bytes");
    return withLock(normalized, async () => {
      assertReservation(normalized, reservation);
      const budget = loadBudget(normalized);
      if (budget.used_bytes + budget.reserved_bytes - (reservation.estimated_bytes ?? 0) + actualBytes > budget.max_bytes) throw governanceError("CONTEXT_BUDGET_EXCEEDED", "Actual retrieval result exceeds the current Context Budget.");
      budget.reserved_calls = Math.max(0, budget.reserved_calls - 1);
      budget.reserved_bytes = Math.max(0, budget.reserved_bytes - (reservation?.estimated_bytes ?? 0));
      if (budget.used_bytes + actualBytes > budget.max_bytes) throw governanceError("CONTEXT_BUDGET_EXCEEDED", "Actual retrieval result exceeds the current Context Budget.");
      budget.used_calls += 1;
      budget.used_bytes += actualBytes;
      const usedKinds = new Set(budget.used_tool_calls ?? []);
      if (typeof reservation?.tool === "string") usedKinds.add(reservation.tool);
      budget.used_tool_calls = [...usedKinds];
      persistBudgetValues(normalized, budget);
      reservations.delete(reservation.reservation_id);
      await audit({ ...normalized, tool: reservation?.tool, resource: reservation?.resource, bytes: actualBytes, success, error, reservation_id: reservation?.reservation_id });
      return cloneBudget(budget);
    });
  }

  async function releaseRetrieval(context, reservation, { success = false, error } = {}) {
    const normalized = resolveContext(context);
    return withLock(normalized, async () => {
      assertReservation(normalized, reservation);
      const budget = loadBudget(normalized);
      budget.reserved_calls = Math.max(0, budget.reserved_calls - 1);
      budget.reserved_bytes = Math.max(0, budget.reserved_bytes - (reservation?.estimated_bytes ?? 0));
      persistBudgetValues(normalized, budget);
      reservations.delete(reservation.reservation_id);
      await audit({ ...normalized, tool: reservation?.tool, resource: reservation?.resource, bytes: 0, success, error, reservation_id: reservation?.reservation_id });
      return cloneBudget(budget);
    });
  }

  async function audit(entry = {}) {
    const timestamp = clock().toISOString();
    const record = { audit_id: randomUUID(), timestamp, task_id: entry.task_id, execution_id: entry.execution_id, tool: entry.tool, resource: entry.resource ?? null, bytes: Number(entry.bytes) || 0, success: entry.success !== false, error: entry.error?.message ?? entry.error ?? null, correlation_id: entry.correlation_id ?? entry.audit_context?.correlation_id ?? null, agent_identity: entry.agent_identity };
    if (database) database.run("INSERT INTO runtime_tool_audit (audit_id, task_id, execution_id, timestamp, audit_json) VALUES (?, ?, ?, ?, ?)", [record.audit_id, record.task_id, record.execution_id, timestamp, JSON.stringify(record)]);
    if (eventStore?.append) eventStore.append({ event_id: record.audit_id, project_id: entry.project_id ?? "runtime", event_type: "tool.retrieval", timestamp, source: "runtime-tool-governance", task_id: record.task_id, correlation_id: record.correlation_id ?? undefined, payload: record, metadata: { task_id: record.task_id, execution_id: record.execution_id } });
    return record;
  }

  async function dispatch(toolName, input, context, execute) {
    if (typeof execute !== "function") throw new ConfigurationError("Tool dispatch requires an executor.");
    const normalized = resolveContext(context);
    const resource = input?.path ?? input?.resource ?? input?.file_paths;
    authorize(toolName, normalized, resource);
    // commit_changes and report_done are the run's exit path. Charging them
    // against the budget lets an exhausted budget block the run from ever
    // committing or reporting (observed as AGENT_REPORT_MISSING), so they are
    // exempt from both call and byte accounting. Their results are small.
    if (toolName === "commit_changes" || toolName === "report_done") {
      const toolContext = buildToolContext(context, normalized);
      return execute(input, toolContext);
    }
    const reservation = await reserveRetrieval(normalized, { tool: toolName, resource, estimatedBytes: input?.max_chars ?? input?.maxChars ?? 0 });
    try {
      // Phase gate: discovery tools count against the exploration budget; the
      // gate opens permanently after the first edit lands.
      if (DISCOVERY_TOOLS.has(toolName)) assertDiscoveryBudget(normalized, discoveryKind(toolName));
      const toolContext = buildToolContext(context, normalized);
      const result = await execute(input, toolContext);
      if (EDIT_TOOLS.has(toolName)) markEditStarted(normalized);
      const bytes = Buffer.byteLength(JSON.stringify(result ?? ""), "utf8");
      await commitRetrieval(normalized, reservation, { bytes, success: true });
      return result;
    } catch (error) {
      await releaseRetrieval(normalized, reservation, { error });
      throw error;
    }
  }

  function buildToolContext(context, normalized) {
    const toolContext = {
      ...context,
      ...normalized,
      allowed_file_paths: normalized.allowed_resources?.allowed_file_paths ?? [],
      allowed_prefixes: normalized.allowed_resources?.allowed_prefixes ?? []
    };
    const known = contexts.get(contextKey(normalized.task_id, normalized.execution_id));
    if (known) {
      Object.defineProperty(toolContext, "verify_result", {
        enumerable: true,
        get: () => known.verify_result,
        set: (value) => { known.verify_result = value; }
      });
    }
    delete toolContext.context_budget;
    delete toolContext.retrieval_budget;
    delete toolContext.consume_retrieval;
    delete toolContext.consumeRetrieval;
    // normalized.changed_paths is a clone; point the tool context at the
    // live stored context array so write_diff/edit_diff can append to it and
    // commit_changes reads the accumulated set in the same execution.
    toolContext.changed_paths = normalized.changed_paths;
    if (context && typeof context === "object") context.changed_paths = normalized.changed_paths;
    // Same live-reference pattern for exploration state: search_code/read_file
    // mutate it and write_diff/edit_diff reset its streak across calls in one
    // execution.
    toolContext.exploration_state = normalized.exploration_state;
    return toolContext;
  }

  function getBudget(contextOrIds = {}) {
    const normalized = resolveContext(contextOrIds);
    return cloneBudget(loadBudget(normalized));
  }

  function resolveContext(context) {
    const taskId = context?.task_id ?? context?.taskId;
    const executionId = context?.execution_id ?? context?.executionId ?? context?.execution_scope?.execution_id ?? context?.execution_scope?.executionId;
    if (!isId(taskId) || !isId(executionId)) throw governanceError("TOOL_SCOPE_INVALID", "Tool call requires task_id and execution_id.");
    const known = contexts.get(contextKey(taskId, executionId));
    if (known) {
      if (context.execution_scope?.task_id && context.execution_scope.task_id !== taskId) throw governanceError("TOOL_SCOPE_INVALID", "execution_scope.task_id does not match task_id.");
      if (context.execution_scope?.execution_id && context.execution_scope.execution_id !== executionId) throw governanceError("TOOL_SCOPE_INVALID", "execution_scope.execution_id does not match execution_id.");
      if (context.agent_identity && JSON.stringify(context.agent_identity) !== JSON.stringify(known.agent_identity)) throw governanceError("TOOL_IDENTITY_INVALID", "Tool caller does not match the execution identity.");
      if (context.lifecycle !== undefined) known.lifecycle = context.lifecycle;
      return { ...known, changed_paths: known.changed_paths };
    }
    if (!context.agent_identity) throw governanceError("TOOL_IDENTITY_INVALID", "Unknown execution requires agent_identity.");
    const created = createExecutionContext(context);
    return Object.assign(created, context);
  }

  function loadBudget(context) {
    const key = contextKey(context.task_id, context.execution_id);
    const knownBudget = contexts.get(key)?.context_budget;
    if (knownBudget) return normalizeBudget(knownBudget);
    if (database) {
      const row = database.all("SELECT budget_json FROM runtime_tool_budget WHERE task_id = ? AND execution_id = ?", [context.task_id, context.execution_id])[0];
      if (row) return normalizeBudget(JSON.parse(row.budget_json));
    }
    return normalizeBudget(context.context_budget ?? context.retrieval_budget);
  }

  function loadPersistedBudget(taskId, executionId) {
    if (!database) return undefined;
    const row = database.all("SELECT budget_json FROM runtime_tool_budget WHERE task_id = ? AND execution_id = ?", [taskId, executionId])[0];
    return row ? JSON.parse(row.budget_json) : undefined;
  }

  function assertReservation(context, reservation) {
    const stored = reservation?.reservation_id ? reservations.get(reservation.reservation_id) : undefined;
    if (!stored || stored !== reservation || reservation.task_id !== context.task_id || reservation.execution_id !== context.execution_id || typeof reservation.tool !== "string") throw governanceError("TOOL_RESERVATION_INVALID", "Retrieval reservation does not belong to this execution.");
  }

  function persistBudget(context) { persistBudgetValues(context, context.context_budget); }
  function persistBudgetValues(context, budget) {
    const value = JSON.stringify(budget);
    if (database) database.run("INSERT INTO runtime_tool_budget (task_id, execution_id, budget_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(task_id, execution_id) DO UPDATE SET budget_json=excluded.budget_json, updated_at=excluded.updated_at", [context.task_id, context.execution_id, value, clock().toISOString()]);
    const known = contexts.get(contextKey(context.task_id, context.execution_id));
    if (known) { known.context_budget = budget; known.retrieval_budget = budget; }
  }

  function withLock(context, operation) {
    const key = contextKey(context.task_id, context.execution_id);
    const previous = locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    locks.set(key, current);
    return current.finally(() => { if (locks.get(key) === current) locks.delete(key); });
  }
}

function ensureTables(database) {
  database.run("CREATE TABLE IF NOT EXISTS runtime_tool_budget (task_id TEXT NOT NULL, execution_id TEXT NOT NULL, budget_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(task_id, execution_id))");
  database.run("CREATE TABLE IF NOT EXISTS runtime_tool_audit (audit_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, execution_id TEXT NOT NULL, timestamp TEXT NOT NULL, audit_json TEXT NOT NULL)");
  database.run("CREATE INDEX IF NOT EXISTS runtime_tool_audit_scope ON runtime_tool_audit(task_id, execution_id, timestamp)");
}
function normalizeBudget(value = {}) {
  if (!value || typeof value !== "object") throw governanceError("CONTEXT_BUDGET_INVALID", "Runtime retrieval budget is invalid.");
  const maxBytes = value.max_bytes ?? value.max_chars ?? DEFAULT_MAX_BYTES;
  const maxCalls = value.max_calls ?? DEFAULT_MAX_CALLS;
  for (const [name, number] of [["max_bytes", maxBytes], ["max_calls", maxCalls]]) if (!Number.isInteger(number) || number < 0) throw governanceError("CONTEXT_BUDGET_INVALID", `${name} must be a non-negative integer.`);
  const usedBytes = value.used_bytes ?? 0; const usedCalls = value.used_calls ?? 0; const reservedBytes = value.reserved_bytes ?? 0; const reservedCalls = value.reserved_calls ?? 0;
  for (const [name, number] of [["used_bytes", usedBytes], ["used_calls", usedCalls], ["reserved_bytes", reservedBytes], ["reserved_calls", reservedCalls]]) if (!Number.isInteger(number) || number < 0) throw governanceError("CONTEXT_BUDGET_INVALID", `${name} must be a non-negative integer.`);
  const usedToolKinds = Array.isArray(value.used_tool_calls) ? value.used_tool_calls.filter((kind) => typeof kind === "string") : [];
  return { max_bytes: maxBytes, max_calls: maxCalls, used_bytes: usedBytes, used_calls: usedCalls, reserved_bytes: reservedBytes, reserved_calls: reservedCalls, used_tool_calls: usedToolKinds };
}
function cloneBudget(value) { return { ...value }; }
function cloneContext(value) { return { ...value, context_budget: cloneBudget(value.context_budget), retrieval_budget: cloneBudget(value.retrieval_budget), capabilities: [...value.capabilities], changed_paths: [...(value.changed_paths ?? [])], exploration_state: cloneExplorationState(value.exploration_state) }; }
function normalizeScope(scope, taskId, executionId) { const result = { ...(scope ?? {}) }; if (result.task_id !== undefined && result.task_id !== taskId) throw governanceError("TOOL_SCOPE_INVALID", "execution_scope.task_id does not match task_id."); if (result.execution_id !== undefined && result.execution_id !== executionId) throw governanceError("TOOL_SCOPE_INVALID", "execution_scope.execution_id does not match execution_id."); result.task_id = taskId; result.execution_id = executionId; return result; }
function resourceList(resource) { return resource === undefined ? [] : Array.isArray(resource) ? resource : [resource]; }
function resourceAllowed(resource, allowed = {}) { if (typeof resource !== "string" || !resource) return false; const paths = allowed.allowed_file_paths ?? allowed.file_paths ?? allowed.paths ?? []; const prefixes = allowed.allowed_prefixes ?? allowed.prefixes ?? []; if (!paths.length && !prefixes.length) return false; return paths.includes(resource) || prefixes.some((prefix) => resource === prefix || resource.startsWith(`${prefix.replace(/\/$/, "")}/`)); }
function contextKey(taskId, executionId) { return `${taskId}\0${executionId}`; }
function isId(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value); }
function nonNegativeInteger(value, name) { const number = Number(value); if (!Number.isInteger(number) || number < 0) throw governanceError("CONTEXT_BUDGET_INVALID", `${name} must be a non-negative integer.`); return number; }
function governanceError(code, message) { const error = new ConfigurationError(message); error.code = code; return error; }
