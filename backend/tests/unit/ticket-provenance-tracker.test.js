import assert from "node:assert/strict";
import test from "node:test";

import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";
import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createTicketProvenanceTracker } from "../../src/modules/governance/ticket-provenance-tracker.js";

test("accepts canonical Architecture Decision to Roadmap to Sprint to Ticket provenance", () => {
  const { tracker, ticket } = setup();
  const result = tracker.registerTicket(ticket);
  ticket.title = "mutated caller input";

  assert.equal(result.architecture_decisions[0].id, "DECISION-124");
  assert.equal(result.roadmap.id, "ROADMAP-124");
  assert.equal(result.sprint.id, "SPRINT-124");
  assert.equal(result.ticket.id, "TICKET-124");
  assert.deepEqual(tracker.getProvenance("TICKET-124"), result);
  assert.throws(() => tracker.registerTicket(ticket), /already exists/);
});

test("rejects orphan tickets and missing governance ancestors", () => {
  const { tracker, ticket } = setup();
  assert.throws(() => tracker.validateProvenance({ ...ticket, id: "TICKET-orphan" }), /does not belong to sprint/);
  assert.throws(() => tracker.validateProvenance({ ...ticket, roadmap_id: "ROADMAP-missing" }), /Roadmap does not exist/);

  const decisions = createArchitectureDecisionStore();
  decisions.append(decision());
  const roadmaps = createRoadmapStore();
  const noDecisionRoadmap = roadmap();
  delete noDecisionRoadmap.architecture_decision_ids;
  roadmaps.save(noDecisionRoadmap);
  const noDecisionTracker = createTicketProvenanceTracker({ roadmaps, decisions });
  assert.throws(() => noDecisionTracker.validateProvenance(ticket), /no Architecture Decision provenance/);
});

function setup() {
  const decisions = createArchitectureDecisionStore();
  decisions.append(decision());
  const roadmaps = createRoadmapStore();
  const saved = roadmaps.save(roadmap());
  return { tracker: createTicketProvenanceTracker({ roadmaps, decisions }), ticket: saved.sprints[0].tickets[0] };
}

function decision() {
  return { id: "DECISION-124", project_id: "PROJECT-124", type: "architecture", title: "Governance chain", decision: "Tickets originate from architecture decisions.", status: "accepted", created_at: "2026-08-20T10:00:00Z" };
}

function roadmap() {
  return {
    id: "ROADMAP-124", project_id: "PROJECT-124", version: "1.0.0", architecture_decision_ids: ["DECISION-124"], created_at: "2026-08-20T10:00:00Z",
    sprints: [{
      id: "SPRINT-124", roadmap_id: "ROADMAP-124", project_id: "PROJECT-124", objective: "Trace tickets", exit_criteria: ["Provenance works"],
      tickets: [{ id: "TICKET-124", project_id: "PROJECT-124", roadmap_id: "ROADMAP-124", sprint_id: "SPRINT-124", title: "Track provenance", objective: "Keep the chain.", acceptance_criteria: ["Chain validates"], provenance: { source: "sprint_plan", source_id: "SPRINT-124", created_at: "2026-08-20T10:00:00Z" } }]
    }]
  };
}
