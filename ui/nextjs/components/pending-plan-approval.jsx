"use client";
// Alerts the owner to an immutable plan awaiting a decision in project chat.
import { useEffect, useState } from "react";
import { PlanReviewModal } from "./plan-review-modal.jsx";

// Loads the latest pending plan and opens its full revision for owner review.
export function PendingPlanApproval({ client, projectId, messages, conversationId, agentId }) {
  const [pending, setPending] = useState(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const messageKey = messages.map((message) => message.id).join("|");

  useEffect(() => {
    let active = true;
    // Refreshes the latest immutable plan status when the conversation changes.
    async function refresh() {
      try {
        const [heads, sprints] = await Promise.all([client.listPlans(projectId), client.listSprints(projectId)]);
        const currentSprintIds = new Set(sprints.map((sprint) => sprint.id));
        const ordered = [...heads].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        let next = null;
        for (const head of ordered) {
          if (head.sprint_id && !currentSprintIds.has(head.sprint_id)) continue;
          const revision = await client.getPlanRevision(projectId, head.plan_id, head.revision);
          if (revision.status === "awaiting_human_approval" || revision.format === "markdown" && revision.status === "approved" && revision.handoff_status !== "completed") { next = revision; break; }
        }
        if (active) { setPending(next); setError(""); }
      } catch (loadError) { if (active) setError(loadError.message); }
    }
    void refresh();
    return () => { active = false; };
  }, [client, projectId, messageKey, open]);

  return <>
    {pending && <div className="home-plan-approval-notice" role="status"><span>Bạn có 1 kế hoạch cần xác nhận</span><button type="button" onClick={() => setOpen(true)}>Approve</button></div>}
    {error && <p className="home-plan-approval-error" role="alert">Không tải được kế hoạch cần duyệt: {error}</p>}
    {open && pending && <PlanReviewModal client={client} projectId={projectId} sprintId={pending.sprint_id} planId={pending.plan_id} conversationId={conversationId} agentId={agentId} onClose={() => setOpen(false)} onChanged={() => setOpen(false)} />}
  </>;
}
