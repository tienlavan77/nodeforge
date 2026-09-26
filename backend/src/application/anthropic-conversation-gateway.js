// Runs Anthropic owner conversations with Forge tool calls through the generic Agent Gateway.
import { ConfigurationError } from "../shared/errors.js";

const MAX_TOOL_ROUNDS = 8;

// Creates an Anthropic conversation adapter with bounded Forge tool execution.
export function createAnthropicConversationGateway({ agentGateway, toolDefinitions, toolRegistry, toolContext, model } = {}) {
  if (typeof agentGateway?.request !== "function") throw new ConfigurationError("Anthropic conversation adapter requires an Agent Gateway.");
  return Object.freeze({ execute, provider: "anthropic", conversationMode: "history" });

  async function execute({ agentId, prompt, correlationId, agent, options = {} } = {}) {
    const forgeTools = options.forgeTools ?? {};
    const definitions = forgeTools.definitions ?? toolDefinitions ?? [];
    const registry = forgeTools.registry ?? toolRegistry ?? {};
    const context = forgeTools.context ?? toolContext;
    const messages = [{ role: "user", content: [{ type: "text", text: prompt }] }];
    const tools = definitions.map((definition) => ({ type: "function", name: definition.name, description: definition.description, input_schema: definition.input_schema }));
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const response = await agentGateway.request({ agentId, correlationId, payload: { messages, ...(model || agent?.model ? { model: model ?? agent.model } : {}), ...(tools.length ? { tools } : {}) } });
      const payload = response.payload ?? {};
      if (!payload.tool_use) return { text: String(payload.text ?? ""), usage: payload.usage, response_id: payload.response_id };
      const call = payload.tool_use;
      const tool = registry?.[call.name];
      if (typeof tool?.execute !== "function") throw new ConfigurationError(`Anthropic requested unavailable Forge tool: ${call.name}.`);
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: call.id, name: call.name, input: call.input ?? {} }] });
      let result;
      try { result = await tool.execute(call.input ?? {}, context); }
      catch (error) { result = { error_code: error.code ?? "TOOL_EXECUTION_FAILED", message: error.message }; }
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result ?? null) }] });
    }
    throw new ConfigurationError("Anthropic conversation exceeded its Forge tool round limit.");
  }
}
