// Routes Ollama-hosted OpenAI models through the Codex SDK instead of Anthropic's Claude protocol.
import { ConfigurationError } from "../../shared/errors.js";

// Creates an Ollama provider adapter that delegates execution to the shared Codex SDK gateway.
export function createOllamaSdkGateway({ codexSdkGateway } = {}) {
  if (typeof codexSdkGateway?.execute !== "function") throw new ConfigurationError("Ollama SDK Gateway requires the Codex SDK gateway.");
  return Object.freeze({ execute, provider: "ollama", conversationMode: codexSdkGateway.conversationMode ?? "thread", builtinWebSearchAvailable: false });

  // Runs an Ollama profile with Codex SDK while preserving its provider identity and execution options.
  async function execute({ agent, agentId, prompt, correlationId, cwd, options, resumeThreadId, onEvent, onSessionReady, abortSignal } = {}) {
    const resolvedAgentId = agentId ?? agent?.agent_id;
    if (typeof resolvedAgentId !== "string" || !resolvedAgentId.trim()) throw new ConfigurationError("Ollama SDK agent_id is required.");
    if (typeof prompt !== "string" || !prompt.trim()) throw new ConfigurationError("Ollama SDK prompt is required.");
    if (typeof correlationId !== "string" || !correlationId.trim()) throw new ConfigurationError("Ollama SDK correlation_id is required.");
    return codexSdkGateway.execute({
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
