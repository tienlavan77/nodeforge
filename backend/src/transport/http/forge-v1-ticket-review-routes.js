// Routes agent and owner ticket reviews under the concise Forge ticket API.
import { requireProject, unavailable } from "./forge-v1-router-utils.js";

// Dispatches ticket review requests while preserving their separate decision records.
export async function routeTicketReview({ method, parts, projectId, body, requestId, correlationId, reviewTicket, ticketHumanReviewService, ticketBlockerDecisionService, ticketBlockerReconcileService }) {
  if (parts.length !== 3 || parts[0] !== "tickets") return null;
  if (parts[2] === "review" && method === "POST") {
    if (typeof reviewTicket !== "function") throw unavailable("Review-only Dispatch");
    requireProject(projectId);
    const result = await reviewTicket({ projectId, ticketId: parts[1], body: { ...body, project_id: projectId } });
    return { status: 202, body: { ...result, request_id: requestId, correlation_id: correlationId } };
  }
  if (parts[2] === "blocker-decision") {
    if (!ticketBlockerDecisionService?.decide) throw unavailable("Ticket Blocker Decision");
    requireProject(projectId);
    if (method === "POST") return { status: 200, body: await ticketBlockerDecisionService.decide({ requestedProjectId: projectId, ticketId: parts[1], actor: body.actor, reason: body.reason, optionId: body.option_id ?? body.optionId }) };
    return null;
  }
  // Reconciles an interrupted (unknown-provider) blocker stage so a later RUN may re-arm it without an automatic provider replay.
  if (parts[2] === "blocker-reconcile") {
    if (typeof ticketBlockerReconcileService !== "function") throw unavailable("Ticket Blocker Reconcile");
    requireProject(projectId);
    if (method === "POST") return { status: 200, body: await ticketBlockerReconcileService({ projectId, ticketId: parts[1], actor: body.actor }) };
    return null;
  }
  if (parts[2] !== "human-review") return null;
  if (!ticketHumanReviewService?.get || !ticketHumanReviewService?.approve) throw unavailable("Ticket Human Review");
  requireProject(projectId);
  if (method === "GET") return { status: 200, body: await ticketHumanReviewService.get({ requestedProjectId: projectId, ticketId: parts[1] }) };
  if (method === "POST") return { status: 200, body: await ticketHumanReviewService.approve({ requestedProjectId: projectId, ticketId: parts[1], actor: "project_owner", reason: body.reason, reviewedAt: body.reviewer_updated_at }) };
  return null;
}
