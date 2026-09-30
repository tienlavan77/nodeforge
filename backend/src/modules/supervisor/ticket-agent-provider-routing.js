// Selects governed agent profiles and provider SDK paths for ticket execution.
import { ConfigurationError } from "../../shared/errors.js";

// Rejects a missing or occupied agent required by an approved ticket contract.
function unavailable(role) {
  return Object.assign(new ConfigurationError(`The contract ${role} is unavailable.`), { code: role === "Reviewer" ? "REVIEWER_NOT_AVAILABLE" : "AGENT_NOT_AVAILABLE" });
}

// Selects and claims the exact Coder signed in a ticket contract before SDK dispatch.
export async function selectTicketCoder({ resolver, occupancy, ticket, taskId, ownerId, role, payload }) {
  const pinnedId = payload.direct_code || payload.tool_test ? null : ticket.execution_contract?.coder;
  const resume = payload.review_resume;
  let selected = resume
    ? resolver.list?.("coder")?.find((profile) => profile.agent_id === resume.agent_id && profile.provider === resume.provider && profile.enabled)
    : payload.direct_code ? selectDirectCoder(resolver, payload.resume_from)
      : pinnedId ? resolver.list?.("coder")?.find((profile) => profile.agent_id === pinnedId && profile.enabled && profile.role === "coder" && profile.status === "ready")
        : resolver.resolveAvailable(role);
  if (pinnedId && selected?.agent_id !== pinnedId) throw unavailable("Coder");
  if (!occupancy || role !== "coder") return { selected, claim: null };
  const existing = occupancy.getByTask(taskId);
  if (pinnedId && existing && existing.agent_id !== pinnedId) throw unavailable("Coder");
  const candidates = existing ? [existing.agent_id] : pinnedId || resume ? [selected?.agent_id]
    : [selected?.agent_id, ...(resolver.list?.("coder") ?? []).filter((profile) => profile.enabled && profile.status === "ready").map((profile) => profile.agent_id)];
  for (const agentId of [...new Set(candidates.filter(Boolean))]) {
    if (payload.resume_from?.agent_id && agentId !== payload.resume_from.agent_id) continue;
    const claim = await occupancy.claim({ agentId, taskId, supervisorId: ownerId });
    if (claim) {
      if (pinnedId && claim.agent_id !== pinnedId) throw unavailable("Coder");
      selected = resolver.list?.("coder")?.find((profile) => profile.agent_id === agentId) ?? selected;
      return { selected, claim };
    }
  }
  throw unavailable("Coder");
}

// Resolves only the Reviewer named by a signed contract when one is present.
export function selectTicketReviewer(resolver, ticket, existingClaim) {
  const pinnedId = ticket.execution_contract?.reviewer;
  if (pinnedId && existingClaim && existingClaim.agent_id !== pinnedId) throw unavailable("Reviewer");
  const profile = existingClaim || pinnedId
    ? resolver.list?.("reviewer")?.find((entry) => entry.agent_id === (existingClaim?.agent_id ?? pinnedId) && entry.enabled && entry.role === "reviewer" && ["ready", "working"].includes(entry.status))
    : resolver.resolveAvailable("reviewer");
  if (!profile) throw unavailable("Reviewer");
  return profile;
}
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
