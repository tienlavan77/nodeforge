// Lets a project owner review a rejected ticket with a durable, distinct human decision.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";

// Exposes Reviewer findings and records an explicit owner approval without rewriting the agent verdict.
export function createTicketHumanReviewService({ projectId, roadmaps, ticketStatusStore, checkpoints, agentOccupancy, ticketWorkspaceService, publisher, projectLogger = () => {} } = {}) {
  if (!projectId || !roadmaps?.getCurrent || !roadmaps?.updateTicketStatus || !ticketStatusStore?.completeByHumanReview || !checkpoints?.load || !checkpoints?.loadReview) throw new ConfigurationError("Ticket Human Review requires roadmap, status, and checkpoint services.");
  return Object.freeze({ get, approve });

  // Reads the current evidence so the owner can decide from the exact Reviewer verdict.
  async function get({ requestedProjectId, ticketId }) {
    const ticket = findTicket(requestedProjectId, ticketId);
    const [coder, reviewer] = await Promise.all([checkpoints.load(ticketId), checkpoints.loadReview(ticketId)]);
    const status = ticketStatusStore.get(ticketId);
    const approved = status?.status === "done" && status.details?.reason === "human_review_approved";
    return { ticket_id: ticket.id, status: ticket.status ?? "planned", approved, eligible: !approved && coder?.status === "completed" && reviewer?.status === "completed" && reviewer?.verdict === "request_changes", reviewer: reviewer ? { verdict: reviewer.verdict ?? null, findings: reviewer.findings ?? [], changed_paths: reviewer.changed_paths ?? [], updated_at: reviewer.updated_at ?? null, reviewer_name: reviewer.reviewer_name ?? null } : null, decision: approved ? status.details : null };
  }

  // Completes a ticket only after an owner explicitly accepts the recorded Reviewer findings.
  async function approve({ requestedProjectId, ticketId, actor, reason, reviewedAt }) {
    const evidence = await get({ requestedProjectId, ticketId });
    if (evidence.approved) {
      if (evidence.status !== "done") {
        if (!roadmaps.updateTicketStatus({ projectId, ticketId, status: "done" })) throw reviewError("HUMAN_REVIEW_PERSIST_FAILED", "Ticket status could not be written to the roadmap.", 500);
        await publishUpdate(ticketId);
      }
      return { ticket_id: ticketId, status: "done", decision: evidence.decision };
    }
    if (!evidence.eligible) throw reviewError("HUMAN_REVIEW_UNAVAILABLE", "Ticket has no completed rejected review to approve.", 409);
    if (typeof actor !== "string" || !actor.trim() || typeof reason !== "string" || !reason.trim()) throw reviewError("HUMAN_REVIEW_INPUT", "Actor and approval reason are required.", 400);
    if (reviewedAt !== evidence.reviewer.updated_at) throw reviewError("HUMAN_REVIEW_STALE", "Reviewer findings changed; reload before approving.", 409);
    if (agentOccupancy?.getByTask?.(ticketId) || agentOccupancy?.getByTask?.(ticketId, "reviewer")) throw reviewError("HUMAN_REVIEW_ACTIVE", "Ticket still has a working agent.", 409);
    if (ticketWorkspaceService) {
      const workspace = await ticketWorkspaceService.open(ticketId);
      if (workspace.migrationRequired) throw reviewError("TICKET_WORKSPACE_MIGRATION_REQUIRED", "Ticket has a pre-ledger worktree commit requiring migration before approval.", 409);
      await workspace.integrate();
      await workspace.changeLedger.release();
    }
    const decision = { decision_id: `HUMAN-REVIEW-${randomUUID()}`, actor: actor.trim(), reason: "human_review_approved", explanation: reason.trim(), reviewer_updated_at: reviewedAt, reviewer_verdict: evidence.reviewer.verdict, reviewed_at: new Date().toISOString() };
    ticketStatusStore.completeByHumanReview(ticketId, decision);
    const roadmap = roadmaps.updateTicketStatus({ projectId, ticketId, status: "done" });
    if (!roadmap) throw reviewError("HUMAN_REVIEW_PERSIST_FAILED", "Ticket status could not be written to the roadmap.", 500);
    await publishUpdate(ticketId);
    projectLogger({ event_name: "ticket.human_review_approved", level: "info", status: "success", message: "Project owner approved ticket after Reviewer requested changes.", task_id: ticketId, ticket_id: ticketId, source: "ticket-human-review-service", payload: { decision_id: decision.decision_id, actor: decision.actor, reviewer_updated_at: reviewedAt } });
    return { ticket_id: ticketId, status: "done", decision };
  }

  // Restricts the decision to an existing ticket in the requested project.
  function findTicket(requestedProjectId, ticketId) {
    if (requestedProjectId !== projectId) throw reviewError("PROJECT_CONTEXT_CONFLICT", "Ticket belongs to a different project.", 409);
    const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((entry) => entry.id === ticketId && entry.project_id === projectId);
    if (!ticket) throw reviewError("TICKET_NOT_FOUND", `Ticket not found: ${ticketId}.`, 404);
    return ticket;
  }

  // Refreshes other open UIs after the roadmap reflects the owner decision.
  async function publishUpdate(ticketId) {
    try { await publisher?.publish?.({ event_id: `EVT-${randomUUID()}`, type: "ticket.updated", project_id: projectId, timestamp: new Date().toISOString(), payload: { ticket_id: ticketId, reason: "human_review_approved" } }); }
    catch (error) { projectLogger({ event_name: "ticket.human_review_publish_failed", level: "error", status: "failed", message: "Human Review was saved but UI refresh event failed.", task_id: ticketId, source: "ticket-human-review-service", error_code: error.code ?? "EVENT_PUBLISH_FAILED", payload: { error: error.message } }); }
  }
}

// Returns a stable API error for review decisions.
function reviewError(code, message, statusCode) { return Object.assign(new ConfigurationError(message), { code, statusCode }); }
