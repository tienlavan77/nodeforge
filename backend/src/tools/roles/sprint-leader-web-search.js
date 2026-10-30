/** Grants Sprint Leader provider-native web research alongside Forge repository
 * discovery without granting shell, write access, or contract approval authority. */

/** Selects supported native search options by profile and gateway capability;
 * compatible Chat Completions providers retain their existing Forge tools. */
export function sprintLeaderWebSearchOptions(profile, gateway) {
  if (profile?.role !== "sprint_leader") return {};
  const available = typeof gateway?.builtinWebSearchAvailable === "function"
    ? gateway.builtinWebSearchAvailable(profile) : gateway?.builtinWebSearchAvailable !== false;
  if (!available) return {};
  if (["claude", "anthropic"].includes(profile.provider)) return { tools: ["WebSearch"] };
  if (profile.provider === "codex") return { networkAccessEnabled: true, webSearchMode: "live" };
  if (profile.provider === "openai" && profile.use_responses !== false) return { builtinWebSearch: true };
  return {};
}

/** Keeps external research separate from project evidence and approved authority
 * so search availability cannot bypass source-bound recovery validation. */
export const SPRINT_LEADER_WEB_SEARCH_PROMPT = "Sprint Leader may additionally use provider-native WebSearch/web_search when exposed for external documentation. Cite web URLs separately from repository evidence; web results never establish project source hashes or approved contract authority. If native web search is unavailable, state that limitation. Built-in shell, file and write tools remain forbidden.";
