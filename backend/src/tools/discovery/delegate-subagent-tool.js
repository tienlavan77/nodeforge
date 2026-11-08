// Read-Only Explorer delegation keeps parallel repository discovery behind a narrow, injected execution boundary.
import { ConfigurationError } from "../../shared/errors.js";
import { recordSourceMetadata } from "./source-metadata-receipts.js";

// Business purpose: describes the bounded Forge capability for parallel read-only exploration.
export const delegateSubagentDefinition = {
  name: "delegate_subagent",
  description: "Delegate up to three independent read-only repository exploration tasks.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["tasks"],
    properties: {
      tasks: {
        type: "array", minItems: 1, maxItems: 3,
        items: {
          type: "object", additionalProperties: false, required: ["id", "objective"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 64 },
            objective: { type: "string", minLength: 1, maxLength: 2000 },
            paths: { type: "array", items: { type: "string", minLength: 1, maxLength: 500 } }
          }
        }
      }
    }
  }
};

export const READ_ONLY_EXPLORER_TOOLS = Object.freeze(["search_tree", "list_files", "search_text", "read_file", "Read", "git_status", "git_diff", "git_log", "git_show", "git_blame"]);
export const MAX_PARALLEL_SUBAGENTS = 3;
export const MAX_SUBAGENTS_PER_TURN = 4;
const SHA256_PATTERN = /^sha256:[a-fA-F0-9]{64}$/;
const SAFE_RELATIVE_PATH = /^(?!\.\.)(?!.*(?:^|\/)\.\.(?:\/|$))(?!\/)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const FORBIDDEN_CHILD_TOOLS = Object.freeze(["edit_diff", "write_diff", "delete_file", "move_file", "run_command", "run_check", "run_test", "check_test", "git_branch", "git_restore", "git_stash", "commit_changes", "push_commit", "delegate_subagent"]);

// Business purpose: creates the parent-owned delegation handler while keeping child execution provider-neutral.
export function createDelegateSubagentTool({ executeTask, maxSummaryChars = 6000, evidenceStore = null } = {}) {
  if (typeof executeTask !== "function") throw new ConfigurationError("delegate_subagent requires an injected child executor.");
  return { definition: delegateSubagentDefinition, execute: (input, context = {}) => executeBatch(input, context) };

  // Technical description: reserves the complete batch synchronously, starts isolated workers in the background, and returns worker handles so the parent can continue.
  async function executeBatch(input, context) {
    const tasks = validateTasks(input);
    const used = Number(context.subagent_reservations ?? 0);
    if (used + tasks.length > MAX_SUBAGENTS_PER_TURN) throw Object.assign(new ConfigurationError("delegate_subagent per-turn child quota exceeded."), { code: "SUBAGENT_QUOTA_EXCEEDED" });
    context.subagent_reservations = used + tasks.length;
    const signal = context.abortSignal;
    const workers = tasks.map((task) => ({ id: task.id, worker_id: `${context.agent_identity?.agent_id ?? "agent"}:sub:${task.id}`, status: "running" }));
    void Promise.allSettled(tasks.map((task) => executeOne(task, context, signal))).then((results) => {
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        for (const file of normalizeObserved(result.value?.raw_observed_files ?? result.value?.observed_files, context, { retainSymbolMap: true })) {
          if (Array.isArray(file.symbol_map) && file.symbol_map.length) recordSourceMetadata(context, { path: file.path, sha256: file.sha256, symbol_map: file.symbol_map });
        }
      }
      const observed = mergeObserved(results.filter((result) => result.status === "fulfilled").flatMap((result) => normalizeObserved(result.value?.observed_files, context)));
      context.observed_files = mergeObserved([...(context.observed_files ?? []), ...observed]);
      context.subagent_usage = mergeUsage([...(context.subagent_usage ?? []), ...results.filter((result) => result.status === "fulfilled").map((result) => result.value?.subagent_usage).filter(Boolean)]);
    }).catch((error) => { context.projectLogger?.({ event_name: "subagent.batch_failed", level: "error", message: error.message, conversation_id: context.conversation_id, delegation_id: context.execution_id }); });
    return { status: "started", workers, tasks_started: tasks.length, tasks_completed: 0, observed_files: [], subagent_usage: [] };
  }

  // Business purpose: executes one isolated read-only child and forwards only the parent abort signal.
  async function executeOne(task, context, signal) {
    if (signal?.aborted) throw Object.assign(new Error("Parent execution was aborted."), { code: "SUBAGENT_ABORTED" });
    if (typeof context !== "object" || context === null) throw new ConfigurationError("delegate_subagent requires a parent execution context.");
    const parentExecutionId = String(context.execution_id ?? context.task_id ?? "parent");
    const childExecutionId = `${parentExecutionId}:sub:${task.id}`;
    const parentIdentity = context.agent_identity ?? {};
    const childContext = {
      parentContext: context,
      task_id: `${context.task_id ?? "subagent"}:${task.id}`,
      execution_id: childExecutionId,
      correlation_id: childExecutionId,
      project_root: context.project_root,
      agent_identity: { ...parentIdentity, agent_id: `${parentIdentity.agent_id ?? "agent"}:sub:${task.id}`, parent_agent_id: parentIdentity.agent_id ?? null },
      capabilities: [...READ_ONLY_EXPLORER_TOOLS],
      tools: [...READ_ONLY_EXPLORER_TOOLS],
      allowed_file_paths: Array.isArray(context.allowed_file_paths) ? [...context.allowed_file_paths] : undefined,
      allowed_prefixes: Array.isArray(context.allowed_prefixes) ? [...context.allowed_prefixes] : undefined,
      exploration_enabled: false,
      read_only_enforced: true,
      subagent_depth: Number(context.subagent_depth ?? 0) + 1,
      abortSignal: signal,
      subagentId: task.id,
      forbidden_tools: [...FORBIDDEN_CHILD_TOOLS],
      assertToolAllowed: (toolName) => {
        if (!READ_ONLY_EXPLORER_TOOLS.includes(toolName)) throw Object.assign(new ConfigurationError(`Subagent tool is not allowed: ${toolName}.`), { code: "SUBAGENT_TOOL_FORBIDDEN" });
        return true;
      }
    };
    if (childContext.subagent_depth > 1) throw Object.assign(new ConfigurationError("delegate_subagent nesting depth exceeded."), { code: "SUBAGENT_NESTING_FORBIDDEN" });
    evidenceStore?.startWorker({ conversationId: context.evidence_scope?.conversationId ?? context.conversation_id, delegationId: context.evidence_scope?.delegationId ?? parentExecutionId, workerId: childContext.agent_identity.agent_id, parentAgentId: parentIdentity.agent_id ?? null, objective: task.objective, eventSink: context.eventSink });
    const result = await executeTask(task, childContext);
    await evidenceStore?.complete({ conversationId: context.evidence_scope?.conversationId ?? context.conversation_id, delegationId: context.evidence_scope?.delegationId ?? parentExecutionId, workerId: childContext.agent_identity.agent_id, parentAgentId: parentIdentity.agent_id ?? null, summary: result?.summary ?? "", observedFiles: childContext.observed_files ?? result?.observed_files ?? [], usage: result?.subagent_usage ?? null, eventSink: context.eventSink });
    const rawObserved = childContext.observed_files ?? result?.observed_files;
    const observed = normalizeObserved(rawObserved, childContext).map((file) => ({
      ...file,
      parent_execution_id: parentExecutionId,
      child_execution_id: childExecutionId,
      child_agent_id: childContext.agent_identity.agent_id,
      observed_at: new Date().toISOString(),
      source_tool: file.source_tool ?? "read_file"
    }));
    return { ...result, raw_observed_files: rawObserved, observed_files: observed };
  }
}

// Technical description: validates the complete batch, including safe unique identifiers, before reservation or spawning.
function validateTasks(input) {
  if (!input || !Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > MAX_PARALLEL_SUBAGENTS) throw new ConfigurationError("delegate_subagent tasks must contain 1 to 3 items.");
  const ids = new Set();
  return input.tasks.map((task) => {
    if (!task || typeof task.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task.id) || ids.has(task.id)) throw new ConfigurationError("delegate_subagent task ids must be unique safe identifiers.");
    if (typeof task.objective !== "string" || !task.objective.trim()) throw new ConfigurationError("delegate_subagent task objective is required.");
    if (task.paths !== undefined && (!Array.isArray(task.paths) || task.paths.some((path) => typeof path !== "string" || !SAFE_RELATIVE_PATH.test(path)))) throw new ConfigurationError("delegate_subagent task paths must be safe relative paths.");
    ids.add(task.id);
    return { id: task.id, objective: task.objective.trim(), ...(Array.isArray(task.paths) ? { paths: [...new Set(task.paths)] } : {}) };
  });
}

// Technical description: keeps only observed metadata with verified path and checksum fields for parent handoff.
function normalizeObserved(files, context = {}, { retainSymbolMap = false } = {}) {
  if (!Array.isArray(files)) return [];
  const allowedPaths = Array.isArray(context.allowed_file_paths) ? context.allowed_file_paths : [];
  const allowedPrefixes = Array.isArray(context.allowed_prefixes) ? context.allowed_prefixes : [];
  const hasScope = allowedPaths.length > 0 || allowedPrefixes.length > 0;
  return files.filter((file) => {
    if (!file || typeof file.path !== "string" || !SAFE_RELATIVE_PATH.test(file.path) || !SHA256_PATTERN.test(file.sha256 ?? "")) return false;
    if (!hasScope) return true;
    return allowedPaths.includes(file.path) || allowedPrefixes.some((prefix) => file.path === prefix || file.path.startsWith(`${String(prefix).replace(/\/$/, "")}/`));
  }).map((file) => {
    const symbolNames = Array.isArray(file.symbol_map)
      ? [...new Set(file.symbol_map.map((symbol) => symbol?.name).filter((name) => typeof name === "string" && name))].slice(0, 40)
      : Array.isArray(file.symbols)
        ? [...new Set(file.symbols.filter((name) => typeof name === "string" && name))].slice(0, 40)
        : undefined;
    return {
      path: file.path,
      sha256: file.sha256,
      symbols_read: [...new Set(Array.isArray(file.symbols_read) ? file.symbols_read.filter((symbol) => typeof symbol === "string") : [])].slice(0, 40),
      ...(symbolNames?.length ? { symbols: symbolNames } : {}),
      ...(retainSymbolMap && Array.isArray(file.symbol_map) ? { symbol_map: file.symbol_map } : {}),
      ...(typeof file.source_tool === "string" ? { source_tool: file.source_tool } : {}),
      ...(typeof file.parent_execution_id === "string" ? { parent_execution_id: file.parent_execution_id } : {}),
      ...(typeof file.child_execution_id === "string" ? { child_execution_id: file.child_execution_id } : {}),
      ...(typeof file.child_agent_id === "string" ? { child_agent_id: file.child_agent_id } : {}),
      ...(typeof file.observed_at === "string" ? { observed_at: file.observed_at } : {})
    };
  });
}

// Technical description: merges duplicate observations without discarding symbols read by another child.
function mergeObserved(files) { const merged = new Map(); for (const file of files) { const current = merged.get(file.path); if (!current) merged.set(file.path, { ...file }); else merged.set(file.path, { ...current, sha256: file.sha256, symbols_read: [...new Set([...(current.symbols_read ?? []), ...(file.symbols_read ?? [])])].slice(0, 40), ...(current.symbols || file.symbols ? { symbols: [...new Set([...(current.symbols ?? []), ...(file.symbols ?? [])])].slice(0, 40) } : {}) }); } return [...merged.values()]; }

// Technical description: bounds child prose before it is returned to the parent context.
function mergeUsage(values) { return values.reduce((total, usage) => { if (typeof usage === "number") return total + usage; if (!usage || typeof usage !== "object") return total; return total + Number(usage.input_tokens ?? usage.inputTokens ?? 0); }, 0); }

function bound(value, max) { return typeof value === "string" ? value.slice(0, max) : ""; }

// Technical description: converts child failures into bounded, provider-neutral result metadata.
function classifyError(error) { return { code: error?.code ?? "SUBAGENT_EXECUTION_FAILED", message: String(error?.message ?? "Subagent execution failed.").slice(0, 240) }; }
