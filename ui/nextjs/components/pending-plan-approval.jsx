"use client";
// Alerts the owner to an immutable plan awaiting a decision in project chat.
import { useEffect, useState } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { PlanReviewModal } from "./plan-review-modal.jsx";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { GitStatusIndicator } from "./git-status-indicator.jsx";

// Loads the latest pending plan and opens its full revision for owner review.
export function PendingPlanApproval({ client, projectId, projectName, messages, conversationId, agentId, onHandoffCompleted }) {
  const [pending, setPending] = useState(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [handoffNotice, setHandoffNotice] = useState("");
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
          const loaded = await client.getPlanRevision(projectId, head.plan_id, head.revision);
          const revision = loaded.format === "markdown" && loaded.handoff_status === "completed" && loaded.sprint_id && !currentSprintIds.has(loaded.sprint_id) ? { ...loaded, handoff_status: "recovery_required" } : loaded;
          if (revision.status === "awaiting_human_approval" || revision.format === "markdown" && revision.status === "approved" && revision.handoff_status !== "completed") { next = revision; break; }
        }
        if (active) { setPending(next); setError(""); }
      } catch (loadError) { if (active) setError(loadError.message); }
    }
    void refresh();
    return () => { active = false; };
  }, [client, projectId, messageKey, open]);

  return <>
    <div className="home-plan-approval-notice" role="status"><div className="home-plan-approval-project"><span className="home-plan-project-icon" aria-label="Project"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 6.5h6l1.7 2H20.5v9.7a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V6.5Z" /></svg></span><strong>{projectName ?? projectId}</strong><span className="home-plan-git-icon" aria-hidden="true">⌘</span><GitStatusIndicator client={client} projectId={projectId} /></div>{pending && <><span>{pending.handoff_status === "recovery_required" ? "Sprint Plan cần khôi phục binding trong Registry" : pending.status === "approved" ? "Kế hoạch đang chờ handoff" : "Bạn có 1 kế hoạch cần xác nhận"}</span><button type="button" onClick={() => setOpen(true)}>{pending.status === "approved" ? "Continue handoff" : "Approve"}</button></>}</div>
    {handoffNotice && <p className="home-plan-handoff-notice" role="status">{handoffNotice}</p>}
    {error && <p className="home-plan-approval-error" role="alert">Không tải được kế hoạch cần duyệt: {error}</p>}
    {open && pending && <PlanReviewModal client={client} projectId={projectId} sprintId={pending.sprint_id} planId={pending.plan_id} initialPlan={pending} conversationId={conversationId} agentId={agentId} onClose={() => setOpen(false)} onChanged={async ({ handoff } = {}) => { setOpen(false); if (handoff?.sprint_id) { setHandoffNotice(`Sprint Plan ${handoff.sprint_id} đã ${handoff.sprint_status === "ready" ? "sẵn sàng" : "tạo"}. Chưa RUN.`); await onHandoffCompleted?.(); } }} />}
  </>;
}
