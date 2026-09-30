// Verifies that Human Review approvals are scoped, audited, and tied to unchanged Reviewer findings.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createTicketHumanReviewService } from "../../src/application/ticket-human-review-service.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";
import { routeTicketReview } from "../../src/transport/http/forge-v1-ticket-review-routes.js";

// Builds an isolated status store and checkpoint-backed ticket for each decision test.
function fixture() {
  const sql = new DatabaseSync(":memory:");
  const database = { all: (query, params = []) => sql.prepare(query).all(...params), run: (query, params = []) => sql.prepare(query).run(...params), transaction: (callback) => { sql.exec("BEGIN"); try { const result = callback(); sql.exec("COMMIT"); return result; } catch (error) { sql.exec("ROLLBACK"); throw error; } } };
  const events = [];
  const published = [];
  const ticketStatusStore = createTicketStatusStore({ database, projectId: "PROJECT", onEvent: (event) => events.push(event) });
  const ticket = { id: "T-1", project_id: "PROJECT", status: "planned" };
  const reviewer = { status: "completed", verdict: "request_changes", updated_at: "2026-09-29T04:35:09Z", findings: ["Build failed"], changed_paths: ["ui/nextjs/lib/a.js"] };
  const roadmaps = { getCurrent: () => ({ sprints: [{ tickets: [ticket] }] }), updateTicketStatus: ({ status }) => { ticket.status = status; return { version: "2" }; } };
  const checkpoints = { load: async () => ({ status: "completed" }), loadReview: async () => reviewer };
  const agentOccupancy = { getByTask: () => null };
  const service = createTicketHumanReviewService({ projectId: "PROJECT", roadmaps, ticketStatusStore, checkpoints, agentOccupancy, publisher: { publish: async (event) => published.push(event) } });
  return { sql, service, ticket, reviewer, ticketStatusStore, events, published, agentOccupancy };
}

test("owner approval records the rejected verdict separately and marks the ticket done", async () => {
  const { sql, service, ticket, reviewer, ticketStatusStore, events, published } = fixture();
  try {
    const before = await service.get({ requestedProjectId: "PROJECT", ticketId: "T-1" });
    assert.equal(before.eligible, true);
    assert.deepEqual(before.reviewer.findings, ["Build failed"]);
    const approved = await service.approve({ requestedProjectId: "PROJECT", ticketId: "T-1", actor: "project_owner", reason: "I accept the build risk", reviewedAt: reviewer.updated_at });
    assert.equal(approved.status, "done");
    assert.equal(ticket.status, "done");
    assert.equal(ticketStatusStore.get("T-1").details.reason, "human_review_approved");
    assert.equal(ticketStatusStore.getHistory("T-1").at(-1).to_status, "done");
    assert.equal(events.at(-1).type, "ticket.status_change");
    assert.equal(published.at(-1).type, "ticket.updated");
    assert.equal(reviewer.verdict, "request_changes");
    assert.equal((await service.get({ requestedProjectId: "PROJECT", ticketId: "T-1" })).approved, true);
    const retried = await service.approve({ requestedProjectId: "PROJECT", ticketId: "T-1", actor: "project_owner", reason: "again", reviewedAt: reviewer.updated_at });
    assert.equal(retried.decision.decision_id, approved.decision.decision_id);
  } finally { sql.close(); }
});

test("owner cannot approve stale findings, another project, or a working agent", async () => {
  const { sql, service, reviewer, agentOccupancy } = fixture();
  try {
    await assert.rejects(service.approve({ requestedProjectId: "PROJECT", ticketId: "T-1", actor: "project_owner", reason: "yes", reviewedAt: "old" }), { code: "HUMAN_REVIEW_STALE" });
    await assert.rejects(service.get({ requestedProjectId: "OTHER", ticketId: "T-1" }), { code: "PROJECT_CONTEXT_CONFLICT" });
    agentOccupancy.getByTask = () => ({ claim_id: "WORKING" });
    await assert.rejects(service.approve({ requestedProjectId: "PROJECT", ticketId: "T-1", actor: "project_owner", reason: "yes", reviewedAt: reviewer.updated_at }), { code: "HUMAN_REVIEW_ACTIVE" });
  } finally { sql.close(); }
});

test("Human Review is exposed under the concise ticket route", async () => {
  const { sql, service, reviewer } = fixture();
  try {
    const get = await routeTicketReview({ method: "GET", parts: ["tickets", "T-1", "human-review"], projectId: "PROJECT", ticketHumanReviewService: service });
    assert.equal(get.body.eligible, true);
    const post = await routeTicketReview({ method: "POST", parts: ["tickets", "T-1", "human-review"], projectId: "PROJECT", body: { actor: "project_owner", reason: "Approved", reviewer_updated_at: reviewer.updated_at }, ticketHumanReviewService: service });
    assert.equal(post.body.status, "done");
  } finally { sql.close(); }
});
