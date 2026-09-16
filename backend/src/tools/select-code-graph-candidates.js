// Summary: Resolves up to four Code Graph candidates from an Agent search intent.

import { ConfigurationError } from "../shared/errors.js";
import { assertExecutionScope } from "./retrieval-governance.js";
import { discoveryNotice } from "./exploration-state.js";

export function createSelectCodeGraphCandidatesTool({ relevantTreeSelector } = {}) {
  return Object.freeze({ name: "select_code_graph_candidates", execute });

  async function execute(input = {}, context = {}) {
    const taskId = context.task_id ?? context.taskId;
    if (typeof taskId !== "string" || !taskId) throw scopedError("TOOL_SCOPE_INVALID", "Candidate selection requires the current task_id.");
    assertExecutionScope(context, taskId);
    if (!new Set(context.capabilities ?? []).has("select_code_graph_candidates")) throw scopedError("TOOL_FORBIDDEN", "Agent is not authorized to select Code Graph candidates.");
    if (typeof input.query !== "string" || !input.query.trim()) throw scopedError("GRAPH_QUERY_REQUIRED", "Candidate retrieval requires a non-empty query.");
    const limit = input.limit === undefined ? 4 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw scopedError("GRAPH_CANDIDATE_LIMIT", "Candidate retrieval limit must be between one and four.");
    if (typeof relevantTreeSelector?.select !== "function") throw scopedError("GRAPH_INDEX_UNAVAILABLE", "Code Graph retrieval is not configured.");
    const task = context.task_context ?? {};
    const result = relevantTreeSelector.select({ title: task.title ?? "", objective: [task.objective ?? "", input.query.trim(), input.context ?? ""].filter(Boolean).join(" "), acceptance_criteria: task.acceptance_criteria ?? [], limit, scope: context.scope ?? "all", allowed_prefixes: context.allowed_prefixes });
    return { task_id: taskId, query: input.query.trim(), index_version: result.index_version ?? null, selected: result.tree.slice(0, limit), discovery_budget: discoveryNotice(context) };
  }
}

function scopedError(code, message) { const error = new ConfigurationError(message); error.code = code; return error; }
