// Routes Ollama models through OpenAI-compatible function calling so Architecture can use Forge tools.
import { ConfigurationError } from "../../shared/errors.js";

// Creates an Ollama adapter that sends governed Forge tools as compatible Chat Completions functions.
export function createOllamaSdkGateway({ openaiSdkGateway } = {}) {
  if (typeof openaiSdkGateway?.execute !== "function") throw new ConfigurationError("Ollama SDK Gateway requires the OpenAI-compatible SDK gateway.");
  return Object.freeze({ execute, provider: "ollama", conversationMode: openaiSdkGateway.conversationMode ?? "history", builtinWebSearchAvailable: false });

  // Runs an Ollama profile through function calling while preserving Forge tools and owner abort signals.
  async function execute({ agent, agentId, prompt, correlationId, cwd, options, resumeThreadId, onEvent, onSessionReady, abortSignal } = {}) {
    const resolvedAgentId = agentId ?? agent?.agent_id;
    if (typeof resolvedAgentId !== "string" || !resolvedAgentId.trim()) throw new ConfigurationError("Ollama SDK agent_id is required.");
    if (typeof prompt !== "string" || !prompt.trim()) throw new ConfigurationError("Ollama SDK prompt is required.");
    if (typeof correlationId !== "string" || !correlationId.trim()) throw new ConfigurationError("Ollama SDK correlation_id is required.");
    return openaiSdkGateway.execute({
      agentId: resolvedAgentId,
      agent,
      prompt,
      correlationId,
      cwd,
      options,
      resumeThreadId,
      onEvent,
      onSessionReady,
      abortSignal
    });
  }
}
