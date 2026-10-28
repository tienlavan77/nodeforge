// Distinguishes a busy independent Reviewer from missing role configuration so
// verified tickets can wait without rerunning Coder or changing provider authority.
import { selectTicketReviewer } from "./ticket-agent-provider-routing.js";

/** Refreshes shared profiles before selection and reports only another live
 * execution's occupancy as a wait, preserving signed Reviewer assignments. */
export function selectAvailableReviewer({ job, resolver, occupancy }) {
  resolver.refresh?.();
  const existing = occupancy?.getByTask?.(job.task_id, "reviewer");
  let profile;
  try { profile = selectTicketReviewer(resolver, job.payload.ticket, existing); }
  catch (error) {
    if (error.code !== "REVIEWER_NOT_AVAILABLE" || existing) throw error;
    const pinned = job.payload.ticket.execution_contract?.reviewer;
    const busy = (resolver.list?.("reviewer") ?? []).find((entry) => entry.enabled && entry.role === "reviewer"
      && entry.agent_id !== job.agent_id && (!pinned || entry.agent_id === pinned)
      && ["ready", "working"].includes(entry.status) && foreignClaim(entry.agent_id, job, occupancy));
    if (busy) throw busyReviewer(busy, foreignClaim(busy.agent_id, job, occupancy));
    throw error;
  }
  const claim = foreignClaim(profile.agent_id, job, occupancy);
  if (profile.agent_id !== job.agent_id && claim) throw busyReviewer(profile, claim);
  return profile;
}

/** Converts an unsuccessful atomic claim into a wait only while the exact
 * Reviewer remains enabled; removed or disabled profiles remain configuration errors. */
export function reviewerClaimFailure({ profile, job, resolver, occupancy }) {
  resolver.refresh?.();
  const current = resolver.list ? resolver.list("reviewer").find((entry) => entry.agent_id === profile.agent_id) : profile;
  if (current?.enabled && current.role === "reviewer" && ["ready", "working"].includes(current.status))
    return busyReviewer(current, foreignClaim(current.agent_id, job, occupancy));
  return Object.assign(new Error("Independent Reviewer is unavailable."), { code: "REVIEWER_NOT_AVAILABLE" });
}

/** Reads occupancy across projects while allowing only this supervisor's
 * existing claim to be reused for the same independent review. */
function foreignClaim(agentId, job, occupancy) {
  return occupancy?.listActive?.().find((claim) => claim.agent_id === agentId
    && (claim.task_id !== job.task_id || claim.supervisor_id !== job.supervisor_id
      || claim.project_id != null && job.project_id != null && claim.project_id !== job.project_id));
}

/** Carries a structured, unstarted scheduling receipt rather than treating
 * occupancy as a provider failure, finding, or request for human approval. */
function busyReviewer(profile, claim) {
  return Object.assign(new Error("Independent Reviewer is busy; retain the verified artifact and wait for availability."), {
    code: "REVIEWER_BUSY", not_started: true,
    agent_wait: { agent_id: profile.agent_id, agent_name: profile.agent_name ?? profile.agent_id,
      claim_id: claim?.claim_id ?? null, busy_task_id: claim?.task_id ?? null, busy_project_id: claim?.project_id ?? null }
  });
}
