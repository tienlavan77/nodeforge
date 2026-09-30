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
    }
  };
}
