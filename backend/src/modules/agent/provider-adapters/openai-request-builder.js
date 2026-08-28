export function buildResponsesInput(payload = {}) {
  if (!Array.isArray(payload.developer_blocks) && !Array.isArray(payload.user_blocks)) return payload.text ?? JSON.stringify(payload);
  const blocks = [];
  for (const block of payload.developer_blocks ?? []) blocks.push({ role: "developer", content: [{ type: "input_text", text: block.content, ...(block.cacheable ? { prompt_cache_breakpoint: true } : {}) }] });
  for (const block of payload.transcript_blocks ?? []) blocks.push({ role: "user", content: [{ type: "input_text", text: JSON.stringify({ round: block.round, instruction: block.instruction, response_summary: block.response_summary, full_request_ref: block.full_request_ref, full_response_ref: block.full_response_ref }) }] });
  for (const block of payload.user_blocks ?? []) blocks.push({ role: "user", content: [{ type: "input_text", text: block.content }] });
  return blocks;
}

export function buildCacheOptions(payload = {}) {
  const config = payload.cache_config;
  if (!config) return undefined;
  return { prompt_cache_key: config.prompt_cache_key, prompt_cache_options: { mode: config.mode, ttl: config.ttl } };
}

export function mapOpenAIUsage(usage = {}) {
  return { cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0), input_tokens: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0), output_tokens: Number(usage.output_tokens ?? usage.completion_tokens ?? 0) };
}
