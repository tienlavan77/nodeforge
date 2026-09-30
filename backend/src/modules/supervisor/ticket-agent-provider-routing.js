// Selects direct Coder profiles and provider SDK paths for ticket execution.
// Selects a ready coder whose SDK implements the governed code execution path.
export function selectDirectCoder(resolver, checkpoint) {
  const providers = new Set(["codex", "claude", "anthropic"]);
  return (resolver.list?.("coder") ?? []).filter((profile) => profile.enabled && profile.status === "ready" && providers.has(profile.provider) && (!checkpoint || profile.agent_id === checkpoint.agent_id && profile.provider === checkpoint.provider))
    .sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")) || String(left.agent_id).localeCompare(String(right.agent_id)))[0];
}

// Selects profiles that use the OpenAI SDK greeting flow.
export function isOpenAiProfile(profile) {
  return ["openai", "xai", "alibaba", "zhipu", "deepseek"].includes(String(profile?.provider ?? "").toLowerCase());
}

// Selects profiles that use the Codex SDK implementation flow.
export function isCodexProfile(profile) {
  return String(profile?.provider ?? "").toLowerCase() === "codex";
}

// Selects profiles that use the Ollama SDK greeting flow.
export function isOllamaProfile(profile) {
  return String(profile?.provider ?? "").toLowerCase() === "ollama";
}
