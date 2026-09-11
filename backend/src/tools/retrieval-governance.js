// Summary: Applies optional Node-owned retrieval budgets and audit hooks to Tool Lab reads.

import { ConfigurationError } from "../shared/errors.js";

const DEFAULT_MAX_CALLS = 20;
const DEFAULT_MAX_BYTES = 200000;

export function assertExecutionScope(context = {}, taskId) {
  const scope = context.execution_scope ?? context.executionScope;
  if (scope !== undefined && (!scope || typeof scope !== "object")) throw scopedError("TOOL_SCOPE_INVALID", "Current execution scope is invalid.");
  const scopedTask = scope?.task_id ?? scope?.taskId;
  if (scope !== undefined && (typeof scopedTask !== "string" || !scopedTask)) throw scopedError("TOOL_SCOPE_INVALID", "Current execution scope requires task_id.");
  if (scopedTask !== undefined && scopedTask !== taskId) throw scopedError("TOOL_SCOPE_INVALID", "Tool task_id does not match the current execution scope.");
}

export function checkRetrievalBudget(context = {}, estimatedBytes = 0, toolName = "tool") {
  const budget = context.context_budget ?? context.retrieval_budget;
  if (budget === undefined) return;
  if (!budget || typeof budget !== "object") throw scopedError("CONTEXT_BUDGET_INVALID", "Node retrieval budget is invalid.");
  const maxBytes = integerOr(budget.max_bytes ?? budget.max_chars, DEFAULT_MAX_BYTES);
  const maxCalls = integerOr(budget.max_calls, DEFAULT_MAX_CALLS);
  const usedBytes = integerOr(budget.used_bytes ?? budget.consumed_bytes, 0);
  const usedCalls = integerOr(budget.used_calls ?? budget.retrieval_count, 0);
  if (maxBytes < 0 || maxCalls < 0 || usedBytes < 0 || usedCalls < 0) throw scopedError("CONTEXT_BUDGET_INVALID", "Node retrieval budget values must be non-negative integers.");
  if (usedCalls >= maxCalls || usedBytes + Math.max(0, estimatedBytes) > maxBytes) throw scopedError("CONTEXT_BUDGET_EXCEEDED", `${toolName} retrieval exceeds the current Context Budget.`);
}

export function recordRetrieval(context = {}, { bytes = 0, tool, kind, taskId, resource } = {}) {
  const budget = context.context_budget ?? context.retrieval_budget;
  const consume = context.consume_retrieval ?? context.consumeRetrieval;
  if (typeof consume === "function") {
    consume({ bytes: Math.max(0, Number(bytes) || 0), tool, kind, task_id: taskId, resource });
  } else if (budget && typeof budget === "object" && !Object.isFrozen(budget)) {
    budget.used_bytes = integerOr(budget.used_bytes ?? budget.consumed_bytes, 0) + Math.max(0, Number(bytes) || 0);
    budget.used_calls = integerOr(budget.used_calls ?? budget.retrieval_count, 0) + 1;
  }
  const audit = context.audit_retrieval ?? context.audit;
  if (typeof audit === "function") {
    void audit({ event: "tool.retrieval", tool, task_id: taskId, kind, resource, bytes: Math.max(0, Number(bytes) || 0), budget: budget ? { max_bytes: budget.max_bytes ?? budget.max_chars, used_bytes: budget.used_bytes, max_calls: budget.max_calls, used_calls: budget.used_calls } : undefined });
  }
}

export function integerOr(value, fallback) { return value === undefined ? fallback : Number.isInteger(value) ? value : -1; }
function scopedError(code, message) { const error = new ConfigurationError(message); error.code = code; return error; }
