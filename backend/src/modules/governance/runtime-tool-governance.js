// Runtime guard for tool authorization, retrieval budgeting, and execution audit trails.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { assertExecutionFileAccess, issueExecutionFileAccess } from "../../tools/execution-file-access.js";
import { isAgentPathAllowed } from "../../tools/tool-authorization.js";
import { assertDiscoveryBudget, createExplorationState, discoveryKind, markEditStarted } from "../../tools/exploration-state.js";
import { assertReservation, buildToolContext, cloneBudget, cloneContext, contextKey, distinctCalls, ensureTables, governanceError, isId, loadBudget, loadPersistedBudget, normalizeBudget, normalizeScope, nonNegativeInteger, persistBudget, persistBudgetValues, resourceAllowed, resourceList, withLock } from "./runtime-tool-governance-state.js";

const TERMINAL_LIFECYCLES = new Set(["COMPLETED", "CANCELLED", "EXPIRED", "FAILED", "NEEDS_HUMAN_REVIEW"]);
const DISCOVERY_TOOLS = new Set(["select_code_graph_candidates", "search_code", "search_tree", "list_files", "search_text", "read_lines", "rg_files", "rg_search", "read_file", "sed_lines", "read_code", "Read", "Glob", "Grep"]);
const EDIT_TOOLS = new Set(["write_diff", "edit_diff", "delete_file", "move_file"]);

// Creates runtime guards for tool authorization, budgeting, and auditing.
export function createRuntimeToolGovernance({ database, eventStore, clock = () => new Date(), fileAccessPolicy } = {}) {
  if (database && (typeof database.run !== "function" || typeof database.all !== "function")) {
    throw new ConfigurationError("Runtime governance database requires run() and all().");
  }
  if (database) ensureTables(database);
  const contexts = new Map();
  const locks = new Map();
  const reservations = new Map();
  const state = { database, contexts, clock };

  return Object.freeze({ createExecutionContext, authorize, assertActive, reserveRetrieval, commitRetrieval, releaseRetrieval, audit, dispatch, getBudget });

  // Initializes a scoped execution context with budget and identity.
  function createExecutionContext(input = {}) {
    if (input.file_access_version !== undefined || input.file_access_policy !== undefined) throw governanceError("FILE_ACCESS_POLICY_INVALID", "Execution creation cannot import file authority from serialized context.");
    const taskId = input.task_id ?? input.taskId;
    const scope = input.execution_scope ?? input.executionScope;
    const executionId = input.execution_id ?? input.executionId ?? scope?.execution_id ?? scope?.executionId;
    if (!isId(taskId) || !isId(executionId)) throw governanceError("TOOL_SCOPE_INVALID", "Runtime context requires task_id and execution_id.");
    if (!input.agent_identity) throw governanceError("TOOL_IDENTITY_INVALID", "Runtime context requires agent_identity.");
    const capabilities = [...new Set(input.capabilities ?? [])];
    const key = contextKey(taskId, executionId);
    const persisted = loadPersistedBudget(database, taskId, executionId);
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
      task_id: taskId, execution_id: executionId, execution_scope: normalizeScope(scope, taskId, executionId),
      agent_identity: input.agent_identity,
      changed_paths: Array.isArray(input.changed_paths) ? [...input.changed_paths] : [],
      capabilities, allowed_resources: input.allowed_resources ?? { allowed_file_paths: input.allowed_file_paths ?? [], allowed_prefixes: input.allowed_prefixes ?? [] },
      context_budget: budget, retrieval_budget: budget, lifecycle: input.lifecycle ?? "RUNNING",
      exploration_state: explorationState, verify_result: input.verify_result ?? input.verifyResult ?? null,
      audit_context: input.audit_context ?? {}
    };
    if (fileAccessPolicy && ["coder", "reviewer"].includes(context.agent_identity.role)) {
      context.project_root = input.project_root;
      context.file_access_version = 2;
      context.file_access_policy = issueExecutionFileAccess({ ...fileAccessPolicy, context: { ...input, ...context,
        allowed_file_paths: context.allowed_resources.allowed_file_paths, allowed_prefixes: context.allowed_resources.allowed_prefixes } });
    }
    contexts.set(key, context);
    persistBudget(state, context);
    return cloneContext(context);
  }

  // Checks capability and resource allowlist for a tool invocation.
  function authorize(toolName, context = {}, resource) {
    const normalized = resolveContext(context);
    assertExecutionFileAccess(normalized);
    assertActive(normalized);
    if (!normalized.capabilities.includes(toolName)) throw governanceError("TOOL_FORBIDDEN", `Agent is not authorized to use ${toolName}.`);
    const operation = EDIT_TOOLS.has(toolName) ? "write" : "read";
    for (const item of resourceList(resource)) if (!(normalized.file_access_version === 2
      ? item === "." && toolName === "search_tree" && operation === "read" || isAgentPathAllowed(item, normalized, { operation })
      : resourceAllowed(item, normalized.allowed_resources, { operation, role: normalized.agent_identity?.role }))) throw governanceError("TOOL_RESOURCE_FORBIDDEN", `Resource is outside the execution allowlist: ${item}.`);
    return true;
  }

  // Ensures the execution lifecycle still permits tool calls.
  function assertActive(context = {}) {
    const lifecycle = String(context.lifecycle ?? "RUNNING").toUpperCase();
    if (TERMINAL_LIFECYCLES.has(lifecycle)) throw governanceError("TOOL_EXECUTION_INACTIVE", `Tool execution is not allowed while lifecycle is ${lifecycle}.`);
    return true;
  }

  // Reserves bytes and call slots before a retrieval tool runs.
  async function reserveRetrieval(context, { tool, resource, estimatedBytes = 0 } = {}) {
    const normalized = resolveContext(context);
    authorize(tool, normalized, resource);
    const bytes = nonNegativeInteger(estimatedBytes, "estimatedBytes");
    return withLock(locks, normalized, async () => {
      const budget = loadBudget(state, normalized);
      if (budget.used_bytes + budget.reserved_bytes + bytes > budget.max_bytes || distinctCalls(budget, tool) > budget.max_calls) {
        throw governanceError("CONTEXT_BUDGET_EXCEEDED", `${tool} retrieval exceeds the current Context Budget.`);
      }
      budget.reserved_calls += 1;
      budget.reserved_bytes += bytes;
      persistBudgetValues(state, normalized, budget);
      const reservation = { task_id: normalized.task_id, execution_id: normalized.execution_id, reservation_id: randomUUID(), tool, resource, estimated_bytes: bytes };
      reservations.set(reservation.reservation_id, reservation);
      return reservation;
    });
  }

  // Commits reserved budget to used and emits an audit event.
  async function commitRetrieval(context, reservation, { bytes = reservation?.estimated_bytes ?? 0, success = true, error } = {}) {
    const normalized = resolveContext(context);
    const actualBytes = nonNegativeInteger(bytes, "bytes");
    return withLock(locks, normalized, async () => {
      assertReservation(reservations, normalized, reservation);
      const budget = loadBudget(state, normalized);
      if (budget.used_bytes + budget.reserved_bytes - (reservation.estimated_bytes ?? 0) + actualBytes > budget.max_bytes) throw governanceError("CONTEXT_BUDGET_EXCEEDED", "Actual retrieval result exceeds the current Context Budget.");
      budget.reserved_calls = Math.max(0, budget.reserved_calls - 1);
      budget.reserved_bytes = Math.max(0, budget.reserved_bytes - (reservation?.estimated_bytes ?? 0));
      if (budget.used_bytes + actualBytes > budget.max_bytes) throw governanceError("CONTEXT_BUDGET_EXCEEDED", "Actual retrieval result exceeds the current Context Budget.");
      budget.used_calls += 1;
      budget.used_bytes += actualBytes;
      const usedKinds = new Set(budget.used_tool_calls ?? []);
      if (typeof reservation?.tool === "string") usedKinds.add(reservation.tool);
      budget.used_tool_calls = [...usedKinds];
      persistBudgetValues(state, normalized, budget);
      reservations.delete(reservation.reservation_id);
      await audit({ ...normalized, tool: reservation?.tool, resource: reservation?.resource, bytes: actualBytes, success, error, reservation_id: reservation?.reservation_id });
      return cloneBudget(budget);
    });
  }

  // Releases a reservation after a failed retrieval.
  async function releaseRetrieval(context, reservation, { success = false, error } = {}) {
    const normalized = resolveContext(context);
    return withLock(locks, normalized, async () => {
      assertReservation(reservations, normalized, reservation);
      const budget = loadBudget(state, normalized);
      budget.reserved_calls = Math.max(0, budget.reserved_calls - 1);
      budget.reserved_bytes = Math.max(0, budget.reserved_bytes - (reservation?.estimated_bytes ?? 0));
      persistBudgetValues(state, normalized, budget);
      reservations.delete(reservation.reservation_id);
      await audit({ ...normalized, tool: reservation?.tool, resource: reservation?.resource, bytes: 0, success, error, reservation_id: reservation?.reservation_id });
      return cloneBudget(budget);
    });
  }

  // Persists and emits an audit record for a tool retrieval attempt.
  async function audit(entry = {}) {
    const timestamp = clock().toISOString();
    const record = { audit_id: randomUUID(), timestamp, task_id: entry.task_id, execution_id: entry.execution_id, tool: entry.tool, resource: entry.resource ?? null, bytes: Number(entry.bytes) || 0, success: entry.success !== false, error: entry.error?.message ?? entry.error ?? null, correlation_id: entry.correlation_id ?? entry.audit_context?.correlation_id ?? null, agent_identity: entry.agent_identity, ...(entry.file_access_policy ? { file_access_policy: entry.file_access_policy.policy } : {}) };
    if (database) database.run("INSERT INTO runtime_tool_audit (audit_id, task_id, execution_id, timestamp, audit_json) VALUES (?, ?, ?, ?, ?)", [record.audit_id, record.task_id, record.execution_id, timestamp, JSON.stringify(record)]);
    if (eventStore?.append) eventStore.append({ event_id: record.audit_id, project_id: entry.project_id ?? "runtime", event_type: "tool.retrieval", timestamp, source: "runtime-tool-governance", task_id: record.task_id, correlation_id: record.correlation_id ?? undefined, payload: record, metadata: { task_id: record.task_id, execution_id: record.execution_id } });
    return record;
  }

  // Authorizes, budgets, and executes a tool with discovery phase gates.
  async function dispatch(toolName, input, context, execute) {
    if (typeof execute !== "function") throw new ConfigurationError("Tool dispatch requires an executor.");
    const normalized = resolveContext(context);
    const resource = ["Read", "Glob", "Grep"].includes(toolName) ? undefined : toolName === "move_file" ? [input?.from_path, input?.to_path].filter(Boolean) : input?.path ?? input?.resource ?? input?.file_paths;
    authorize(toolName, normalized, resource);
    if (toolName === "commit_changes" || toolName === "push_commit" || toolName === "report_done" || toolName === "respond_to_review" || toolName === "lookup_schema") return execute(input, buildToolContext(context, normalized, contexts));
    const reservation = await reserveRetrieval(normalized, { tool: toolName, resource, estimatedBytes: input?.max_chars ?? input?.maxChars ?? 0 });
    try {
      if (DISCOVERY_TOOLS.has(toolName)) assertDiscoveryBudget(normalized, discoveryKind(toolName), input);
      const result = await execute(input, buildToolContext(context, normalized, contexts));
      if (EDIT_TOOLS.has(toolName)) markEditStarted(normalized);
      const bytes = Buffer.byteLength(JSON.stringify(result ?? ""), "utf8");
      await commitRetrieval(normalized, reservation, { bytes, success: true });
      return result;
    } catch (error) {
      await releaseRetrieval(normalized, reservation, { error });
      throw error;
    }
  }

  // Returns a snapshot of the current budget for an execution.
  function getBudget(contextOrIds = {}) {
    const normalized = resolveContext(contextOrIds);
    return cloneBudget(loadBudget(state, normalized));
  }

  // Resolves or auto-creates the normalized execution context.
  function resolveContext(context) {
    const taskId = context?.task_id ?? context?.taskId;
    const executionId = context?.execution_id ?? context?.executionId ?? context?.execution_scope?.execution_id ?? context?.execution_scope?.executionId;
    if (!isId(taskId) || !isId(executionId)) throw governanceError("TOOL_SCOPE_INVALID", "Tool call requires task_id and execution_id.");
    const known = contexts.get(contextKey(taskId, executionId));
    if (known) {
      if (context.execution_scope?.task_id && context.execution_scope.task_id !== taskId) throw governanceError("TOOL_SCOPE_INVALID", "execution_scope.task_id does not match task_id.");
      if (context.execution_scope?.execution_id && context.execution_scope.execution_id !== executionId) throw governanceError("TOOL_SCOPE_INVALID", "execution_scope.execution_id does not match execution_id.");
      if (context.agent_identity && JSON.stringify(context.agent_identity) !== JSON.stringify(known.agent_identity)) throw governanceError("TOOL_IDENTITY_INVALID", "Tool caller does not match the execution identity.");
      if ((context.file_access_version !== undefined || context.file_access_policy !== undefined)
        && (context.file_access_version !== known.file_access_version || context.file_access_policy !== known.file_access_policy)) throw governanceError("FILE_ACCESS_POLICY_INVALID", "Tool caller cannot replace the Node file access policy.");
      if (context.lifecycle !== undefined) known.lifecycle = context.lifecycle;
      return { ...known, changed_paths: known.changed_paths };
    }
    if (!context.agent_identity) throw governanceError("TOOL_IDENTITY_INVALID", "Unknown execution requires agent_identity.");
    const created = createExecutionContext(context);
    return { ...context, ...created };
  }
}
