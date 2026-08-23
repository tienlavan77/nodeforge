// Keep stable context in its own content block so Anthropic can cache it.
export function buildMessages(payload = {}) {
  if (!payload.stable_context && !payload.dynamic_context) return [{ role: "user", content: payload.text ?? JSON.stringify(payload) }];
  const messages = [];
  if (payload.stable_context) {
    const { _cache_control: cacheControl, ...stableForProvider } = payload.stable_context;
    messages.push({ role: "user", content: [{ type: "text", text: JSON.stringify(stableForProvider), ...(payload.cache_enabled && cacheControl === "ephemeral" ? { cache_control: { type: "ephemeral" } } : {}) }] });
  }
  messages.push({ role: "user", content: JSON.stringify(payload.dynamic_context ?? { instruction: payload.text ?? "" }) });
  return messages;
}

export function mapUsage(usage = {}) {
  return { input_tokens: Number(usage.input_tokens ?? 0), output_tokens: Number(usage.output_tokens ?? 0), cache_creation_input_tokens: Number(usage.cache_creation_input_tokens ?? 0), cache_read_input_tokens: Number(usage.cache_read_input_tokens ?? 0) };
}
