// Stores runtime governance state helpers for execution budgets and tool authorization.
import { ConfigurationError } from "../../shared/errors.js";
import { cloneExplorationState } from "../../tools/exploration-state.js";

export const DEFAULT_MAX_BYTES = 200000;
export const DEFAULT_MAX_CALLS = 20;

// Initializes persistent tables used by runtime governance.
export function ensureTables(database) {
  database.run("CREATE TABLE IF NOT EXISTS runtime_tool_budget (task_id TEXT NOT NULL, execution_id TEXT NOT NULL, budget_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(task_id, execution_id))");
  database.run("CREATE TABLE IF NOT EXISTS runtime_tool_audit (audit_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, execution_id TEXT NOT NULL, timestamp TEXT NOT NULL, audit_json TEXT NOT NULL)");
  database.run("CREATE INDEX IF NOT EXISTS runtime_tool_audit_scope ON runtime_tool_audit(task_id, execution_id, timestamp)");
}

// Normalizes raw budget values with defaults and validation.
export function normalizeBudget(value = {}) {
  if (!value || typeof value !== "object") throw governanceError("CONTEXT_BUDGET_INVALID", "Runtime retrieval budget is invalid.");
  const maxBytes = value.max_bytes ?? value.max_chars ?? DEFAULT_MAX_BYTES;
  const maxCalls = value.max_calls ?? DEFAULT_MAX_CALLS;
  for (const [name, number] of [["max_bytes", maxBytes], ["max_calls", maxCalls]]) if (!Number.isInteger(number) || number < 0) throw governanceError("CONTEXT_BUDGET_INVALID", `${name} must be a non-negative integer.`);
  const usedBytes = value.used_bytes ?? 0; const usedCalls = value.used_calls ?? 0; const reservedBytes = value.reserved_bytes ?? 0; const reservedCalls = value.reserved_calls ?? 0;
  for (const [name, number] of [["used_bytes", usedBytes], ["used_calls", usedCalls], ["reserved_bytes", reservedBytes], ["reserved_calls", reservedCalls]]) if (!Number.isInteger(number) || number < 0) throw governanceError("CONTEXT_BUDGET_INVALID", `${name} must be a non-negative integer.`);
  const usedToolKinds = Array.isArray(value.used_tool_calls) ? value.used_tool_calls.filter((kind) => typeof kind === "string") : [];
  return { max_bytes: maxBytes, max_calls: maxCalls, used_bytes: usedBytes, used_calls: usedCalls, reserved_bytes: reservedBytes, reserved_calls: reservedCalls, used_tool_calls: usedToolKinds };
}

// Counts distinct tool kinds for call-budget enforcement.
export function distinctCalls(budget, nextTool) {
  const names = new Set(budget.used_tool_calls ?? []);
  if (nextTool) names.add(nextTool);
  return names.size;
}

// Builds a mutable tool context that shares live state with the stored execution.
export function buildToolContext(context, normalized, contexts) {
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
  toolContext.changed_paths = normalized.changed_paths;
  if (context && typeof context === "object") context.changed_paths = normalized.changed_paths;
  toolContext.exploration_state = normalized.exploration_state;
  return toolContext;
}

// Loads a previously persisted budget by task and execution id.
export function loadPersistedBudget(database, taskId, executionId) {
  if (!database) return undefined;
  const row = database.all("SELECT budget_json FROM runtime_tool_budget WHERE task_id = ? AND execution_id = ?", [taskId, executionId])[0];
  return row ? JSON.parse(row.budget_json) : undefined;
}

// Loads the current budget from memory or persisted storage.
export function loadBudget({ database, contexts }, context) {
  const key = contextKey(context.task_id, context.execution_id);
  const knownBudget = contexts.get(key)?.context_budget;
  if (knownBudget) return normalizeBudget(knownBudget);
  if (database) {
    const row = database.all("SELECT budget_json FROM runtime_tool_budget WHERE task_id = ? AND execution_id = ?", [context.task_id, context.execution_id])[0];
    if (row) return normalizeBudget(JSON.parse(row.budget_json));
  }
  return normalizeBudget(context.context_budget ?? context.retrieval_budget);
}

// Persists the current execution budget.
export function persistBudget({ database, contexts, clock }, context) {
  persistBudgetValues({ database, contexts, clock }, context, context.context_budget);
}

// Persists specific budget values for an execution.
export function persistBudgetValues({ database, contexts, clock }, context, budget) {
  const value = JSON.stringify(budget);
  if (database) database.run("INSERT INTO runtime_tool_budget (task_id, execution_id, budget_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(task_id, execution_id) DO UPDATE SET budget_json=excluded.budget_json, updated_at=excluded.updated_at", [context.task_id, context.execution_id, value, clock().toISOString()]);
  const known = contexts.get(contextKey(context.task_id, context.execution_id));
  if (known) { known.context_budget = budget; known.retrieval_budget = budget; }
}

// Validates that a reservation belongs to the given execution.
export function assertReservation(reservations, context, reservation) {
  const stored = reservation?.reservation_id ? reservations.get(reservation.reservation_id) : undefined;
  if (!stored || stored !== reservation || reservation.task_id !== context.task_id || reservation.execution_id !== context.execution_id || typeof reservation.tool !== "string") throw governanceError("TOOL_RESERVATION_INVALID", "Retrieval reservation does not belong to this execution.");
}

// Serializes async operations per execution key.
export function withLock(locks, context, operation) {
  const key = contextKey(context.task_id, context.execution_id);
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  locks.set(key, current);
  return current.finally(() => { if (locks.get(key) === current) locks.delete(key); });
}

// Shallow-clones a budget object.
export function cloneBudget(value) { return { ...value }; }

// Deep-clones an execution context with budget and exploration state.
export function cloneContext(value) { return { ...value, context_budget: cloneBudget(value.context_budget), retrieval_budget: cloneBudget(value.retrieval_budget), capabilities: [...value.capabilities], changed_paths: [...(value.changed_paths ?? [])], exploration_state: cloneExplorationState(value.exploration_state) }; }

// Normalizes and validates execution scope identifiers.
export function normalizeScope(scope, taskId, executionId) { const result = { ...(scope ?? {}) }; if (result.task_id !== undefined && result.task_id !== taskId) throw governanceError("TOOL_SCOPE_INVALID", "execution_scope.task_id does not match task_id."); if (result.execution_id !== undefined && result.execution_id !== executionId) throw governanceError("TOOL_SCOPE_INVALID", "execution_scope.execution_id does not match execution_id."); result.task_id = taskId; result.execution_id = executionId; return result; }

// Normalizes a resource argument into an array.
export function resourceList(resource) { return resource === undefined ? [] : Array.isArray(resource) ? resource : [resource]; }

// Checks whether a resource is inside the allowed paths or prefixes.
export function resourceAllowed(resource, allowed = {}) { if (typeof resource !== "string" || !resource) return false; const paths = allowed.allowed_file_paths ?? allowed.file_paths ?? allowed.paths ?? []; const prefixes = allowed.allowed_prefixes ?? allowed.prefixes ?? []; if (!paths.length && !prefixes.length) return false; return paths.includes(resource) || prefixes.some((prefix) => resource === prefix || resource.startsWith(`${prefix.replace(/\/$/, "")}/`)); }

// Builds a compound key for task and execution lookup.
export function contextKey(taskId, executionId) { return `${taskId}\0${executionId}`; }

// Validates identifier format for tasks and executions.
export function isId(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value); }

// Validates that a numeric value is a non-negative integer.
export function nonNegativeInteger(value, name) { const number = Number(value); if (!Number.isInteger(number) || number < 0) throw governanceError("CONTEXT_BUDGET_INVALID", `${name} must be a non-negative integer.`); return number; }

// Creates a coded ConfigurationError for governance violations.
export function governanceError(code, message) { const error = new ConfigurationError(message); error.code = code; return error; }
