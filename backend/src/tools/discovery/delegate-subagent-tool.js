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

export const READ_ONLY_EXPLORER_TOOLS = Object.freeze(["search_tree", "list_files", "search_text", "read_file", "Read"]);
export const MAX_PARALLEL_SUBAGENTS = 3;
export const MAX_SUBAGENTS_PER_TURN = 4;

// Business purpose: creates the parent-owned delegation handler while keeping child execution provider-neutral.
export function createDelegateSubagentTool({ executeTask, maxSummaryChars = 6000 } = {}) {
  if (typeof executeTask !== "function") throw new ConfigurationError("delegate_subagent requires an injected child executor.");
  return { definition: delegateSubagentDefinition, execute: (input, context = {}) => executeBatch(input, context) };

  // Technical description: validates and reserves the complete batch synchronously before any child starts.
  async function executeBatch(input, context) {
    const tasks = validateTasks(input);
    const used = Number(context.subagent_reservations ?? 0);
    if (used + tasks.length > MAX_SUBAGENTS_PER_TURN) throw Object.assign(new ConfigurationError("delegate_subagent per-turn child quota exceeded."), { code: "SUBAGENT_QUOTA_EXCEEDED" });
    context.subagent_reservations = used + tasks.length;
    const signal = context.abortSignal;
    const results = await Promise.allSettled(tasks.map((task) => executeOne(task, context, signal)));
    const taskResults = results.map((result, index) => result.status === "fulfilled"
      ? { id: tasks[index].id, status: "fulfilled", summary: bound(result.value?.summary, maxSummaryChars), observed_files: normalizeObserved(result.value?.observed_files), subagent_usage: result.value?.subagent_usage ?? null }
      : { id: tasks[index].id, status: "rejected", error: classifyError(result.reason), summary: "", observed_files: [] });
    const observed = mergeObserved(taskResults.flatMap((item) => item.observed_files));
    for (const file of observed) recordSourceMetadata(context, { path: file.path, sha256: file.sha256, symbol_map: file.symbol_map ?? [] });
    context.observed_files = mergeObserved([...(context.observed_files ?? []), ...observed]);
    const usage = taskResults.map((item) => item.subagent_usage).filter(Boolean);
    context.subagent_usage = mergeUsage([...(context.subagent_usage ?? []), ...usage]);
    return { status: taskResults.every((item) => item.status === "fulfilled") ? "completed" : "partial_success", tasks: taskResults, tasks_completed: taskResults.filter((item) => item.status === "fulfilled").length, observed_files: observed, subagent_usage: usage };
  }

  // Business purpose: executes one isolated read-only child and forwards only the parent abort signal.
  async function executeOne(task, context, signal) {
    if (signal?.aborted) throw Object.assign(new Error("Parent execution was aborted."), { code: "SUBAGENT_ABORTED" });
    return executeTask(task, { parentContext: context, tools: READ_ONLY_EXPLORER_TOOLS, exploration_enabled: false, abortSignal: signal, subagentId: task.id });
  }
}

// Technical description: validates the complete batch, including safe unique identifiers, before reservation or spawning.
function validateTasks(input) {
  if (!input || !Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > MAX_PARALLEL_SUBAGENTS) throw new ConfigurationError("delegate_subagent tasks must contain 1 to 3 items.");
  const ids = new Set();
  return input.tasks.map((task) => {
    if (!task || typeof task.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task.id) || ids.has(task.id)) throw new ConfigurationError("delegate_subagent task ids must be unique safe identifiers.");
    if (typeof task.objective !== "string" || !task.objective.trim()) throw new ConfigurationError("delegate_subagent task objective is required.");
    ids.add(task.id);
    return { id: task.id, objective: task.objective.trim(), ...(Array.isArray(task.paths) ? { paths: [...task.paths] } : {}) };
  });
}

// Technical description: keeps only observed metadata with verified path and checksum fields for parent handoff.
function normalizeObserved(files) { return Array.isArray(files) ? files.filter((file) => file && typeof file.path === "string" && typeof file.sha256 === "string").map((file) => ({ path: file.path, sha256: file.sha256, symbols_read: [...new Set(Array.isArray(file.symbols_read) ? file.symbols_read.filter((symbol) => typeof symbol === "string") : [])], ...(Array.isArray(file.symbol_map) ? { symbol_map: file.symbol_map } : {}) })) : []; }

// Technical description: merges duplicate observations without discarding symbols read by another child.
function mergeObserved(files) { const merged = new Map(); for (const file of files) { const current = merged.get(file.path); if (!current) merged.set(file.path, { ...file }); else merged.set(file.path, { ...current, sha256: file.sha256, symbols_read: [...new Set([...(current.symbols_read ?? []), ...(file.symbols_read ?? [])])] }); } return [...merged.values()]; }

// Technical description: bounds child prose before it is returned to the parent context.
function mergeUsage(values) { return values.reduce((total, usage) => { if (typeof usage === "number") return total + usage; if (!usage || typeof usage !== "object") return total; return total + Number(usage.input_tokens ?? usage.inputTokens ?? 0); }, 0); }

function bound(value, max) { return typeof value === "string" ? value.slice(0, max) : ""; }

// Technical description: converts child failures into bounded, provider-neutral result metadata.
function classifyError(error) { return { code: error?.code ?? "SUBAGENT_EXECUTION_FAILED", message: String(error?.message ?? "Subagent execution failed.").slice(0, 240) }; }
