// Distinguishes durable Coder occupancy from missing or disabled profiles so coordination can wait without changing provider authority.
import { ConfigurationError } from "../../shared/errors.js";

// Checks the exact contracted or checkpoint Coder without claiming it; atomic claim remains the final dispatch authority.
export function assertTicketCoderAvailable({ resolver, occupancy, ticket, taskId, ownerId, payload = {} }) {
  if (payload.review_resume) return;
  let agentId = (!payload.direct_code && !payload.tool_test && ticket.execution_contract?.coder)
    || payload.review_resume?.agent_id || payload.resume_from?.agent_id;
  if (!agentId && !payload.direct_code && !payload.tool_test && (!ticket.required_role || ticket.required_role === "coder") && resolver?.list) {
    const profiles = resolver.list("coder").filter((entry) => entry.enabled && entry.role === "coder");
    if (profiles.some((entry) => entry.status === "ready" && !occupancy?.listActive?.().some((claim) => claim.agent_id === entry.agent_id))) return;
    agentId = profiles.find((entry) => ["ready", "working"].includes(entry.status)
      && occupancy?.listActive?.().some((claim) => claim.agent_id === entry.agent_id
        && (claim.task_id !== taskId || claim.supervisor_id !== ownerId)))?.agent_id;
  }
  if (!agentId || !resolver?.list) return;
  const profile = resolver.list("coder")?.find((entry) => entry.agent_id === agentId);
  if (!profile?.enabled || profile.role !== "coder" || !["ready", "working"].includes(profile.status))
    throw Object.assign(new ConfigurationError("The contract Coder is unavailable."), { code: "AGENT_NOT_AVAILABLE" });
  const claim = occupancy?.listActive?.().find((entry) => entry.agent_id === agentId);
  if (claim && (claim.task_id !== taskId || claim.supervisor_id !== ownerId))
    throw Object.assign(new ConfigurationError("The contract Coder is busy with another execution; no provider was started."), {
      code: "AGENT_BUSY", not_started: true,
      agent_wait: { agent_id: agentId, claim_id: claim.claim_id, busy_task_id: claim.task_id, busy_project_id: claim.project_id ?? null }
    });
}
