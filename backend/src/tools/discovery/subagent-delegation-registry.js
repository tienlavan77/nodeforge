// Business purpose: tracks asynchronous subagent delegations so parent agents can continue independent work and collect results at an explicit barrier.
// Technical description: provides tool definitions and an execution-scoped registry for accepting background exploration tasks, querying worker progress, and merging collected results into parent context.
import { ConfigurationError } from "../../shared/errors.js";
import { recordSourceMetadata } from "./source-metadata-receipts.js";
import { emitDelegatedDiscoveryTelemetry, recordDelegationReceipt } from "./delegated-discovery-policy.js";

// Business purpose: exposes non-blocking lifecycle inspection so a parent can continue independent work.
export const getSubagentStatusDefinition = Object.freeze({
  name: "get_subagent_status",
  description: "Get progress for an accepted subagent delegation.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["delegation_id"],
    properties: {
      delegation_id: { type: "string", minLength: 1 }
    }
  }
});

// Business purpose: provides an explicit barrier for collecting completed subagent work.
export const collectSubagentResultsDefinition = Object.freeze({
  name: "collect_subagent_results",
  description: "Collect partial or completed results from a subagent delegation.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["delegation_id"],
    properties: {
      delegation_id: { type: "string", minLength: 1 },
      wait: { type: "boolean" },
      timeout_ms: { type: "integer", minimum: 0, maximum: 180000 }
    }
  }
});

// Business purpose: creates an execution-scoped async subagent coordinator with status polling and barrier collection tools.
// Technical description: stores active background delegations in memory, tracks per-worker lifecycle transitions, and merges observed files and usage into the parent context when results are collected.
export function createSubagentDelegationRegistry({ executeOne, normalizeObserved, mergeObserved, mergeUsage, bound, classifyError, maxSummaryChars = 6000 } = {}) {
  const delegations = new Map();
  let nextDelegationSeq = 1;

  const resolveDelegation = (input, context) => {
    const state = delegations.get(String(input?.delegation_id ?? ""));
    if (!state) throw Object.assign(new ConfigurationError("Unknown subagent delegation."), { code: "SUBAGENT_DELEGATION_NOT_FOUND" });
    if (state.context !== context && state.context?.conversation_id !== context?.conversation_id) {
      throw Object.assign(new ConfigurationError("Subagent delegation scope mismatch."), { code: "SUBAGENT_SCOPE_FORBIDDEN" });
    }
    return state;
  };

  const normalizeTaskOutcome = (task, result, context) => {
    const fallback = result?.status === "fallback_to_parent" || result?.fallback_to_parent === true;
    for (const file of normalizeObserved(result?.raw_observed_files ?? result?.observed_files, context, { retainSymbolMap: true })) {
      if (Array.isArray(file.symbol_map) && file.symbol_map.length) recordSourceMetadata(context, { path: file.path, sha256: file.sha256, symbol_map: file.symbol_map });
    }
    return {
      id: task.id,
      status: fallback ? "fallback_to_parent" : "fulfilled",
      ...(fallback ? { fallback_to_parent: true } : {}),
      ...(result?.subagent_model ? { subagent_model: result.subagent_model } : {}),
      ...(result?.subagent_provider ? { subagent_provider: result.subagent_provider } : {}),
      summary: bound(result?.summary, maxSummaryChars),
      observed_files: normalizeObserved(result?.observed_files, context),
      subagent_usage: result?.subagent_usage ?? null
    };
  };

  const acceptBatch = (tasks, context, signal) => {
    const delegationId = `${String(context.execution_id ?? context.task_id ?? "parent")}:delegation:${nextDelegationSeq++}`;
    const workers = tasks.map((task) => ({
      id: task.id,
      worker_id: `${context.agent_identity?.agent_id ?? "agent"}:sub:${task.id}`,
      objective: task.objective,
      status: "queued"
    }));
    recordDelegationReceipt(context, {
      delegation_id: delegationId,
      status: "running",
      read_only_enforced: true,
      tasks
    });
    emitDelegatedDiscoveryTelemetry(context, "subagent.delegation_created", "accepted", `Accepted async subagent delegation ${delegationId} (${tasks.length} tasks).`, {
      delegation_id: delegationId,
      task_count: tasks.length
    });
    const state = { delegation_id: delegationId, context, tasks, workers, results: new Map(), usageMerged: false, done: null };
    delegations.set(delegationId, state);
    state.done = Promise.all(tasks.map(async (task, index) => {
      const worker = workers[index];
      if (signal?.aborted) { worker.status = "cancelled"; return; }
      worker.status = "running";
      try {
        const value = await executeOne(task, context, signal, delegationId);
        const normalized = normalizeTaskOutcome(task, value, context);
        state.results.set(task.id, normalized);
        worker.status = normalized.status === "fallback_to_parent" ? "fallback_to_parent" : "completed";
        if (normalized.fallback_to_parent) worker.fallback_to_parent = true;
      } catch (error) {
        state.results.set(task.id, { id: task.id, status: "rejected", fallback_to_parent: true, error: classifyError(error), summary: "", observed_files: [] });
        worker.status = signal?.aborted ? "cancelled" : "failed";
        worker.fallback_to_parent = true;
      }
    })).then(() => {
      const allFallback = workers.length > 0 && workers.every((w) => w.status === "fallback_to_parent" || w.fallback_to_parent);
      const allCancelled = workers.length > 0 && workers.every((w) => w.status === "cancelled");
      const finalStatus = allCancelled ? "cancelled" : allFallback ? "fallback_to_parent" : "completed";
      recordDelegationReceipt(context, {
        delegation_id: delegationId,
        status: finalStatus,
        read_only_enforced: true,
        fallback_to_parent: allFallback,
        fallback_reason: allFallback ? "All async subagent tasks failed or fell back to parent." : null,
        tasks
      });
    });
    return { status: "accepted", delegation_id: delegationId, task_count: tasks.length, tasks_started: tasks.length, read_only: true, workers };
  };

  const statusTool = {
    definition: getSubagentStatusDefinition,
    execute: async (input = {}, context = {}) => {
      const state = resolveDelegation(input, context);
      const terminal = state.workers.every((worker) => ["completed", "failed", "fallback_to_parent", "cancelled"].includes(worker.status));
      const allFallback = terminal && state.workers.length > 0 && state.workers.every((worker) => worker.status === "fallback_to_parent");
      const anyFailed = state.workers.some((worker) => worker.status === "failed" || worker.status === "fallback_to_parent");
      return {
        delegation_id: state.delegation_id,
        status: !terminal ? "running" : allFallback ? "fallback_to_parent" : anyFailed ? "partial_success" : "completed",
        tasks_started: state.tasks.length,
        tasks_completed: state.workers.filter((worker) => worker.status === "completed").length,
        workers: state.workers.map((worker) => ({ ...worker, ...(state.results.has(worker.id) ? { result: state.results.get(worker.id) } : {}) }))
      };
    }
  };

  const collectTool = {
    definition: collectSubagentResultsDefinition,
    execute: async (input = {}, context = {}) => {
      const state = resolveDelegation(input, context);
      if (input?.wait !== false) {
        const timeoutMs = Number(input?.timeout_ms ?? 180000);
        await (Number.isFinite(timeoutMs) && timeoutMs > 0 ? Promise.race([state.done, new Promise((resolve) => setTimeout(resolve, timeoutMs))]) : state.done);
      }
      const taskResults = state.tasks.map((task) => state.results.get(task.id)).filter(Boolean);
      const observed = mergeObserved(taskResults.flatMap((item) => item.observed_files ?? []));
      context.observed_files = mergeObserved([...(context.observed_files ?? []), ...observed]);
      const usage = taskResults.map((item) => item.subagent_usage).filter(Boolean);
      if (!state.usageMerged && taskResults.length === state.tasks.length) {
        context.subagent_usage = mergeUsage([...(context.subagent_usage ?? []), ...usage]);
        state.usageMerged = true;
      }
      const complete = taskResults.length === state.tasks.length;
      const allFallback = complete && taskResults.length > 0 && taskResults.every((item) => item.status === "fallback_to_parent");
      const allFulfilled = complete && taskResults.every((item) => item.status === "fulfilled");
      return {
        delegation_id: state.delegation_id,
        status: !complete ? "partial" : allFallback ? "fallback_to_parent" : allFulfilled ? "completed" : "partial_success",
        ...(allFallback ? { fallback_to_parent: true } : {}),
        workers: state.workers,
        tasks: taskResults,
        tasks_started: state.tasks.length,
        tasks_completed: taskResults.filter((item) => item.status === "fulfilled").length,
        observed_files: observed,
        subagent_usage: usage
      };
    }
  };

  return { acceptBatch, statusTool, collectTool };
}
