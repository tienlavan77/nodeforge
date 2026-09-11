// Summary: Runs Codex-profile Forge tool-lab as a direct Responses function-calling loop, bypassing the MCP bridge.

import { ConfigurationError } from "../../shared/errors.js";

const DEFAULT_MAX_ROUNDS = 12;

export function createCodexForgeToolLoop({ agentGateway } = {}) {
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

    while (rounds < maxRounds) {
      rounds += 1;
      const response = await agentGateway.request({ agentId, payload: { messages, ...context?.gateway_payload }, correlationId, tools });
      const payload = response?.payload ?? {};
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

      messages.push({ type: "function_call", call_id: toolUse.id, name: toolUse.name, arguments: JSON.stringify(toolUse.input ?? {}) });
      messages.push({ type: "function_call_output", call_id: toolUse.id, output: JSON.stringify(result ?? null) });
      if (toolUse.name === "report_done") {
        if (typeof result?.summary === "string" && result.summary) finalText = result.summary;
        break;
      }
    }

    if (rounds >= maxRounds && toolEvents.at(-1)?.tool !== "report_done") {
      const error = new ConfigurationError(`Codex Forge tool loop exceeded ${maxRounds} rounds without reporting done.`);
      error.code = "CODEX_TOOL_LOOP_ROUND_LIMIT";
      throw error;
    }
    return { text: finalText, tool_events: toolEvents, rounds };
  }
}

function toResponsesTool(definition) {
  const parameters = definition.parameters ?? definition.input_schema;
  if (!definition?.name || !parameters) throw new ConfigurationError("Codex Forge tool definition requires a name and input schema.");
  return { type: "function", name: definition.name, description: definition.description, parameters };
}

function normalizeToolUse(toolUse) {
  if (!toolUse || typeof toolUse !== "object" || typeof toolUse.name !== "string") return null;
  let input = toolUse.input;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { input = {}; }
  }
  if (input === undefined || input === null) input = {};
  return { id: toolUse.id ?? toolUse.call_id ?? null, name: toolUse.name, input };
}

async function emit(onToolEvent, event) {
  if (typeof onToolEvent === "function") await onToolEvent(event);
}
