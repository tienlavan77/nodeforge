import { ConfigurationError } from "../../shared/errors.js";
import { persistAgentResponse } from "../agent/response-persistence.js";
import { stage1AgentTools } from "../workflows/stage1-agent-tools.js";
import { readTranscriptBlocksDefinition, selectCodeGraphCandidatesDefinition, searchCodeDefinition, readCodeDefinition, readFileDefinition, writeDiffDefinition, runTestDefinition, checkTestDefinition, commitChangesDefinition, reportDoneDefinition } from "../../tools/index.js";

const RESPONSE_FUNCTION_TOOLS = new Set([
  "code_needed",
  "planning",
  "submit_code_response",
  "patch_repair_response",
  "usage_needed",
  "no_wiring_needed",
  "completed",
  "continue"
]);
export function createSenderWorker({ queue, agentRegistry, agentResolver, eventBus, processedStore, protocolStorage, conversationStateStore, conversationIdResolver = (job) => `CONV-BUILDER-${job.task_id}`, workerId = "sender-1", statusBus, signalBus, projectLogger = () => {}, toolRegistry, runtimeGovernance } = {}) {
  if (typeof queue?.claim !== "function" || typeof agentRegistry?.resolve !== "function" || typeof eventBus?.publish !== "function") throw new ConfigurationError("Sender Worker requires queue, agent registry and event bus.");
  const defaultAgentId = () => agentResolver?.resolve?.("coder") ?? "builder";
  const processed = new Map();
  let timer; let heartbeat; let unsubscribe;
  return Object.freeze({ processOnce, start, stop });
  function start(intervalMs = 250) { if (timer) return; statusBus?.publish({ worker_id: workerId, worker_type: "sender", status: "ready", sequence: Date.now() }); heartbeat = setInterval(() => statusBus?.publish({ worker_id: workerId, worker_type: "sender", status: "ready", sequence: Date.now() }), 15000); heartbeat.unref?.(); unsubscribe = signalBus?.onWakeup?.((message) => { if (message.target === "agent.request" || message.queue === "agent.request") void processOnce(); }); }
  function stop() { if (timer) clearInterval(timer); if (heartbeat) clearInterval(heartbeat); unsubscribe?.(); unsubscribe = undefined; timer = undefined; heartbeat = undefined; statusBus?.publish({ worker_id: workerId, worker_type: "sender", status: "stopped", sequence: Date.now() }); }
  async function processOnce() {
    const job = await queue.claim(workerId); if (!job) return null;
    const stored = await processedStore?.get?.(job.request_id);
    if (stored || processed.has(job.request_id)) { const result = stored ?? processed.get(job.request_id); await queue.ack(job.id); return result; }
    try { const agentId = job.agent_id ?? defaultAgentId(); projectLogger({ event_name: "sender.request_started", level: "info", status: "info", message: "Sender Worker started agent request.", task_id: job.task_id, correlation_id: job.correlation_id, source: "sender-worker", payload: { request_id: job.request_id, worker_id: workerId, agent_id: agentId } }); const { adapter } = agentRegistry.resolve(agentId); const response = await runAgentTurns(adapter, { ...job, agent_id: agentId }); const event = identityEvent(job, "agent.response.received", { response }); await persistResponse(job, response); projectLogger({ event_name: "sender.response_persisted", level: "info", status: "success", message: "Sender Worker persisted agent response before publishing.", task_id: job.task_id, correlation_id: job.correlation_id, source: "sender-worker", payload: { request_id: job.request_id, worker_id: workerId } }); processed.set(job.request_id, event); await processedStore?.save?.(job.request_id, event); await eventBus.publish(event); projectLogger({ event_name: "sender.response_received", level: "info", status: "success", message: "Sender Worker published agent response.", task_id: job.task_id, correlation_id: job.correlation_id, source: "sender-worker", payload: { request_id: job.request_id, worker_id: workerId } }); await queue.ack(job.id); return event; }
    catch (error) {
      if (error?.rawResponse !== undefined && protocolStorage) {
        const round = Number(job.payload?.step_id ?? 1);
        await persistAgentResponse({ protocolStorage, taskId: job.task_id, round, response: error.rawResponse, raw: true }).catch(() => {});
      }
      const event = identityEvent(job, "agent.response.failed", { error: { code: error.code ?? "AGENT_REQUEST_FAILED", message: error.message } });
      await eventBus.publish(event); projectLogger({ event_name: "sender.response_failed", level: "error", status: "failed", message: "Sender Worker published agent failure.", task_id: job.task_id, correlation_id: job.correlation_id, source: "sender-worker", error_code: error.code ?? "AGENT_REQUEST_FAILED", payload: { request_id: job.request_id, worker_id: workerId, error: error.message } }); await queue.ack(job.id); return event;
    }
  }
  function toolsForRequest(job) {
    const payload = job.payload ?? {};
    const type = payload.type ?? job.type;
    const expected = payload.expected_output?.type;
    const name = expected === "submit_code_response" || type === "code_provide"
      ? "submit_code_response"
      : expected === "planning" || type === "planning"
        ? "planning"
        : "code_needed";
    const responseTool = (type === "code_provide" || expected === "submit_code_response")
      ? stage1AgentTools.filter((tool) => tool.name === "submit_code_response")
      : stage1AgentTools.filter((tool) => tool.name === name);
    // Capabilities advertised in execution_context only authorize Forge tools;
    // the provider still needs their function definitions to call them.
    const capabilities = new Set(payload.execution_context?.capabilities ?? []);
    const retrievalTools = [
      [capabilities.has("read_transcript_blocks"), readTranscriptBlocksDefinition],
      [capabilities.has("select_code_graph_candidates"), selectCodeGraphCandidatesDefinition],
      [capabilities.has("search_code"), searchCodeDefinition],
      [capabilities.has("read_code"), readCodeDefinition],
      [capabilities.has("read_file"), readFileDefinition],
      [capabilities.has("write_diff"), writeDiffDefinition],
      [capabilities.has("run_test"), runTestDefinition],
      [capabilities.has("check_test"), checkTestDefinition],
      [capabilities.has("commit_changes"), commitChangesDefinition],
      [capabilities.has("report_done"), reportDoneDefinition]
    ].filter(([enabled]) => enabled).map(([, definition]) => definition);
    return [...responseTool, ...retrievalTools];
  }

  async function runAgentTurns(adapter, job) {
    let payload = job.payload;
    const maxTurns = Number(payload?.tool_context?.max_turns ?? payload?.max_tool_turns ?? 8);
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const response = await adapter.send({ agentId: job.agent_id ?? defaultAgentId(), payload, correlationId: job.correlation_id, tools: job.tools ?? toolsForRequest(job) });
      await persistResponse(job, response);
      const calls = extractToolCalls(response);
      // Response function tools (code_needed, planning, submit_code_response, ...)
      // are the Agent's answer, not context requests: return them to the
      // Supervisor instead of treating them as Forge retrieval tools.
      if (!calls.length || calls.every((call) => RESPONSE_FUNCTION_TOOLS.has(call.name))) return response;
      const results = [];
      for (const call of calls) {
        const tool = toolRegistry?.[call.name];
        if (!tool?.execute) throw Object.assign(new ConfigurationError(`Unknown Agent tool: ${call.name}.`), { code: "TOOL_NOT_FOUND" });
        const baseContext = job.payload?.execution_context ?? job.execution_context ?? {};
        // Tools authorize against the request context: transcript blocks and the
        // approved file allowlist live on the payload, not in execution_context.
        const taskBlock = (payload?.user_blocks ?? []).find((block) => block?.block_id === "task_context");
        const acceptanceBlock = (payload?.user_blocks ?? []).find((block) => block?.block_id === "acceptance_criteria");
        const task_context = baseContext.task_context ?? payload?.task_context ?? payload?.ticket ?? payload?.task ?? { title: taskBlock?.content ?? "", acceptance_criteria: acceptanceBlock?.content ? acceptanceBlock.content.split("\n").filter(Boolean) : [] };
        const approvedPaths = baseContext.allowed_resources?.allowed_file_paths ?? baseContext.allowed_file_paths ?? (payload?.plan ?? []).filter((item) => item?.path).map((item) => item.path);
        const context = { ...baseContext, task_context, ticket: payload?.ticket ?? payload?.task ?? baseContext.ticket ?? baseContext.task ?? task_context, task: payload?.ticket ?? payload?.task ?? baseContext.task ?? task_context, transcript_blocks: baseContext.transcript_blocks ?? payload?.transcript_blocks ?? [], allowed_file_paths: approvedPaths, changed_paths: baseContext.changed_paths ?? approvedPaths };
        projectLogger({ event_name: "agent.tool_call", level: "info", status: "started", message: "Agent invoked a Forge tool.", task_id: job.task_id, correlation_id: job.correlation_id, source: "sender-worker", payload: { request_id: job.request_id, worker_id: workerId, tool: call.name, turn, tool_call_id: call.id ?? null, input: summarizeToolInput(call.input), task_context: summarizeTaskContext(task_context) } });
        let result;
        try {
          result = await tool.execute(call.input, context);
          projectLogger({ event_name: "agent.tool_result", level: "info", status: "success", message: "Forge tool returned a result to the Agent.", task_id: job.task_id, correlation_id: job.correlation_id, source: "sender-worker", payload: { request_id: job.request_id, worker_id: workerId, tool: call.name, turn, tool_call_id: call.id ?? null, result: summarizeToolResult(result) } });
        } catch (error) {
          projectLogger({ event_name: "agent.tool_result", level: "error", status: "failed", message: "Forge tool failed for the Agent.", task_id: job.task_id, correlation_id: job.correlation_id, source: "sender-worker", error_code: error.code ?? "TOOL_EXECUTION_FAILED", payload: { request_id: job.request_id, worker_id: workerId, tool: call.name, turn, tool_call_id: call.id ?? null, error: error.message } });
          throw error;
        }
        results.push({ tool_call_id: call.id ?? null, name: call.name, result });
        await protocolStorage?.save?.(`task/${job.task_id}/request_${job.request_id}/tool_${turn}_${results.length}`, { request_id: job.request_id, turn, call, result }, { replace: false, schemaId: "https://forge.local/schemas/agent/tool-turn.schema.json" }).catch?.(() => {});
        if (call.name === "report_done") return response;
      }
      payload = appendToolExchange(payload, response, results);
    }
    throw Object.assign(new ConfigurationError("Agent exceeded the maximum tool turns."), { code: "TOOL_TURN_LIMIT" });
  }

  function appendToolExchange(payload, response, results) {
    const provider = payload.provider ?? payload.provider_name ?? payload.agent_provider ?? "openai";
    const providerFamily = provider === "devquote" || provider === "claude" || provider === "anthropic" ? "anthropic" : provider;
    const calls = extractToolCalls(response);
    const exchange = providerFamily === "anthropic"
      ? { role: "assistant", content: calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input })) }
      : { type: "function_call", call_id: calls[0]?.id, name: calls[0]?.name, arguments: JSON.stringify(calls[0]?.input ?? {}) };
    const outputs = providerFamily === "anthropic"
      ? { role: "user", content: results.map((item) => ({ type: "tool_result", tool_use_id: item.tool_call_id, content: JSON.stringify(item.result) })) }
      : results.map((item) => ({ type: "function_call_output", call_id: item.tool_call_id, output: JSON.stringify(item.result) }));
    return { ...payload, messages: [...(payload.messages ?? []), exchange, outputs], tool_results: [...(payload.tool_results ?? []), ...results] };
  }
  function summarizeToolInput(input = {}) { return { query: input.query, context: input.context, limit: input.limit, path: input.path, symbol: input.symbol, files_requested: input.files_requested }; }
  function summarizeTaskContext(context = {}) { return { title: context.title, objective: context.objective, acceptance_criteria: context.acceptance_criteria }; }
  function summarizeToolResult(result = {}) { return { task_id: result.task_id, query: result.query, index_version: result.index_version, selected_count: Array.isArray(result.selected) ? result.selected.length : undefined, match_count: Array.isArray(result.matches) ? result.matches.length : undefined, path: result.path }; }
  function extractToolCalls(response) {
    const calls = response?.tool_calls ?? response?.payload?.tool_calls ?? response?.output?.filter?.((item) => item?.type === "function_call");
    if (Array.isArray(calls)) return calls.map((call) => ({ id: call.id ?? call.call_id, name: call.name ?? call.function?.name, input: call.input ?? parseArguments(call.function?.arguments ?? call.arguments) })).filter((call) => call.name && call.input && typeof call.input === "object");
    const single = response?.tool_use ?? response?.payload?.tool_use;
    return single?.name && single.input ? [{ id: single.id, name: single.name, input: single.input }] : [];
  }

  function parseArguments(value) { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return null; } }

  async function persistResponse(job, response) {
    const round = Number(job.payload?.step_id ?? (job.payload?.type === "planning" ? 2 : job.payload?.type === "code_provide" ? 3 : 1));
    await persistAgentResponse({ protocolStorage, taskId: job.task_id, round, response });
    if (conversationStateStore?.update) {
      const providerResponseId = response?.provider_metadata?.response_id ?? response?.response_id ?? response?.payload?.response_id ?? null;
      await conversationStateStore.update(conversationIdResolver(job), { last_provider_response_id: providerResponseId, last_provider_status: response?.status ?? "completed" }).catch(() => {});
    }
  }
}
function identityEvent(job, type, payload) { return { type, task_id: job.task_id, supervisor_id: job.supervisor_id, request_id: job.request_id, correlation_id: job.correlation_id, attempt: job.attempt ?? 1, payload }; }
