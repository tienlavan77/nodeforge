// Summary: Runs Codex-profile Forge tool-lab as a direct Responses function-calling loop, bypassing the MCP bridge.

import { ConfigurationError } from "../../shared/errors.js";

const DEFAULT_MAX_ROUNDS = 24;

// Creates the iterative loop that calls the gateway and executes tool results until done.
export function createCodexForgeToolLoop({ agentGateway, projectLogger } = {}) {
  if (typeof agentGateway?.request !== "function") throw new ConfigurationError("Codex Forge tool loop requires an Agent Gateway.");
  return Object.freeze({ run });

  async function run({ agentId, correlationId, prompt, definitions, registry, context, maxRounds = DEFAULT_MAX_ROUNDS, onToolEvent } = {}) {
    if (typeof prompt !== "string" || !prompt) throw new ConfigurationError("Codex Forge tool loop requires a prompt.");
    if (!Array.isArray(definitions) || definitions.length === 0) throw new ConfigurationError("Codex Forge tool loop requires tool definitions.");
    if (!registry || typeof registry !== "object") throw new ConfigurationError("Codex Forge tool loop requires a tool registry.");
    const tools = definitions.map(toResponsesTool);
    const allowed = new Set(tools.map((tool) => tool.name));
    const messages = [{ role: "user", content: [{ type: "input_text", text: prompt }] }];
    const toolEvents = [];
    let finalText = "";
    let rounds = 0;
    // Responses-side cache chaining: the adapter turns cache_config +
    // previous_response_id into store:true + previous_response_id, so the
    // provider can hit prompt cache across rounds instead of re-ingesting the
    // full transcript every turn.
    const cacheConfig = context?.gateway_payload?.cache_config ?? defaultCacheConfig(context);
    let previousResponseId = context?.gateway_payload?.previous_response_id ?? (cacheConfig ? "store_only" : undefined);
    const usageByRound = [];
    const recordUsage = (response) => {
      const usage = response?.payload?.usage ?? response?.usage;
      if (!usage || typeof usage !== "object") return;
      const cached = Number(usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0);
      const input = Number(usage.input_tokens ?? 0);
      const entry = {
        input_tokens: input,
        output_tokens: Number(usage.output_tokens ?? 0),
        cache_read_input_tokens: cached,
        cache_hit_rate: input > 0 ? Number((cached / input).toFixed(4)) : null
      };
      usageByRound.push(entry);
      if (typeof projectLogger === "function") {
        projectLogger({ event_name: "agent.loop.usage", level: "debug", status: "success", message: "Agent round token usage.", task_id: context?.task_id, correlation_id: correlationId, source: "codex-forge-tool-loop", payload: { round: rounds, agent_id: agentId, ...entry } });
      }
    };

    while (rounds < maxRounds) {
      rounds += 1;
      const response = await agentGateway.request({ agentId, payload: { messages, ...(cacheConfig ? { cache_config: cacheConfig } : {}), ...(previousResponseId !== undefined ? { previous_response_id: previousResponseId } : {}), ...context?.gateway_payload }, correlationId, tools });
      const payload = response?.payload ?? {};
      if (payload.response_id) previousResponseId = payload.response_id;
      recordUsage(response);
      const toolUse = normalizeToolUse(payload.tool_use ?? payload.toolCalls?.[0] ?? payload.tool_calls?.[0]);
      if (typeof payload.text === "string" && payload.text) finalText = payload.text;
      if (!toolUse) break;

      const event = { status: "completed", tool: toolUse.name, call_id: toolUse.id, arguments: toolUse.input, result: undefined, error: undefined };
      if (!allowed.has(toolUse.name) || typeof registry[toolUse.name]?.execute !== "function") {
        event.status = "failed";
        event.error = { error_code: "TOOL_NOT_ALLOWED", message: `Tool ${toolUse.name} is not exposed to this session.` };
        toolEvents.push(event);
        await emit(onToolEvent, event);
        break;
      }

      let result;
      try {
        result = await registry[toolUse.name].execute(toolUse.input, context);
      } catch (error) {
        event.status = "failed";
        event.error = { error_code: error?.code ?? "TOOL_EXECUTION_FAILED", message: error?.message ?? "Tool execution failed." };
        result = event.error;
      }
      event.result = result;
      toolEvents.push(event);
      await emit(onToolEvent, event);

      // A failed tool is returned to the model as a function_call_output error
      // so it can fix inputs and retry, matching the MCP bridge's isError path.
      // Terminal success is still guarded: report_done only records a report
      // after the governed tools it depends on have run (see lifecycle tools).
      messages.push({ type: "function_call", call_id: toolUse.id, name: toolUse.name, arguments: JSON.stringify(toolUse.input ?? {}) });
      messages.push({ type: "function_call_output", call_id: toolUse.id, output: JSON.stringify(result ?? null) });
      if (toolUse.name === "report_done" && event.status !== "failed") {
        if (typeof result?.summary === "string" && result.summary) finalText = result.summary;
        break;
      }
    }

    if (rounds >= maxRounds && toolEvents.at(-1)?.tool !== "report_done") {
      const error = new ConfigurationError(`Codex Forge tool loop exceeded ${maxRounds} rounds without reporting done.`);
      error.code = "CODEX_TOOL_LOOP_ROUND_LIMIT";
      throw error;
    }
    return { text: finalText, tool_events: toolEvents, rounds, usage: aggregateUsage(usageByRound) };
  }

// Aggregates per-round token and cache usage into totals.
  function aggregateUsage(entries) {
    return entries.reduce((totals, entry) => ({
      rounds: totals.rounds + 1,
      input_tokens: totals.input_tokens + entry.input_tokens,
      output_tokens: totals.output_tokens + entry.output_tokens,
      cache_read_input_tokens: totals.cache_read_input_tokens + entry.cache_read_input_tokens
    }), { rounds: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
  }
}

// Builds the default prompt cache key config from project and task ids.
function defaultCacheConfig(context) {
  const projectId = context?.ticket?.project_id ?? context?.task?.project_id;
  const taskId = context?.task_id;
  if (!projectId || !taskId) return undefined;
  return { prompt_cache_key: `forge:${projectId}:${taskId}`, mode: "explicit", ttl: "30m" };
}

// Converts a Forge tool definition into the Responses function-tool shape.
function toResponsesTool(definition) {
  const parameters = definition.parameters ?? definition.input_schema;
  if (!definition?.name || !parameters) throw new ConfigurationError("Codex Forge tool definition requires a name and input schema.");
  return { type: "function", name: definition.name, description: definition.description, parameters };
}

// Normalizes a raw tool_use envelope, parsing string inputs when needed.
function normalizeToolUse(toolUse) {
  if (!toolUse || typeof toolUse !== "object" || typeof toolUse.name !== "string") return null;
  let input = toolUse.input;
  if (typeof input === "string") {
    // eslint-disable-next-line no-silent-catch -- Tool-input probe: non-JSON input defaults to {} by design.
    try { input = JSON.parse(input); } catch { input = {}; }
  }
  if (input === undefined || input === null) input = {};
  return { id: toolUse.id ?? toolUse.call_id ?? null, name: toolUse.name, input };
}

async function emit(onToolEvent, event) {
  if (typeof onToolEvent === "function") await onToolEvent(event);
}
