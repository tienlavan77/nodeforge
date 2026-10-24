// Calls the ticket Human Review API for project-owner decisions on rejected reviews.

// Adds read and approve requests without exposing Reviewer agent mutation endpoints.
export function createTicketHumanReviewClient({ forgeV1, requestJson }) {
  return {
    // Loads findings and approval eligibility for a ticket.
    getTicketHumanReview(projectId, ticketId) {
      return requestJson(forgeV1(`/tickets/${encodeURIComponent(ticketId)}/human-review`, { project: projectId }), { fallbackError: "Node could not load Human Review." });
    },
    // Records a project-owner approval with a reason tied to the displayed verdict.
    approveTicketHumanReview(projectId, ticketId, { actor, reason, reviewerUpdatedAt }) {
      return requestJson(forgeV1(`/tickets/${encodeURIComponent(ticketId)}/human-review`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: projectId, actor, reason, reviewer_updated_at: reviewerUpdatedAt }), fallbackError: "Node could not approve Human Review." });
    },
    // Records the owner's chosen option for an AM blocker escalation proposal.
    decideTicketBlocker(projectId, ticketId, { actor, reason, optionId }) {
      return requestJson(forgeV1(`/tickets/${encodeURIComponent(ticketId)}/blocker-decision`, { project: projectId }), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: projectId, actor, reason, option_id: optionId }), fallbackError: "Node could not record the blocker decision." });
    },
    /** Records a direct authenticated answer to a displayed technical question;
     * request identity prevents a stale browser tab from answering another run. */
    respondTicketBlocker(projectId, ticketId, { request_id, job_id, execution_id, answer, token }) {
      return requestJson(forgeV1(`/tickets/${encodeURIComponent(ticketId)}/blocker-response`, { project: projectId }), {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ project_id: projectId, request_id, job_id, execution_id, answer }), fallbackError: "Node could not record the Owner response." });
    }
  };
}
