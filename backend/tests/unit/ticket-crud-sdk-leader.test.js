import assert from "node:assert/strict";
import test from "node:test";

import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createProseTicketService } from "../../src/application/prose-ticket-service.js";
import { createTicketCrudService } from "../../src/application/ticket-crud-service.js";

// Covers the SDK sprint-leader path: the leader searches with built-in tools
// and its verified candidates are kept without server-side re-resolution.
function createService({ agentStream, agentRoleResolver, candidateResolver, sprintLeader } = {}) {
  const roadmaps = createRoadmapStore({});
  const proseTicketService = createProseTicketService({ roadmapStore: roadmaps });
  const service = createTicketCrudService({ roadmaps, proseTicketService, agentStream, agentRoleResolver, candidateResolver, sprintLeader });
  return { roadmaps, service };
}

test("sdk sprint leader candidates are kept without server-side resolve", async () => {
  let streamCalls = 0;
  let resolveCalls = 0;
  const seen = [];
  const { service } = createService({
    agentStream: async function* () { streamCalls += 1; yield { text: "{}" }; },
    agentRoleResolver: { resolve: () => "AGENT-SL-1" },
    candidateResolver: { resolve: async (draft) => { resolveCalls += 1; return draft; } },
    sprintLeader: {
      requestTicket: async (args) => {
        seen.push(args);
        return { title: "Fix chat", objective: "Fix the chat panel.", acceptance_criteria: ["Panel works."], style: ["frontend"], candidate_files: [{ path: "ui/nextjs/components/NodeForgePanels.jsx", role: "PATCH", symbol: "NodeForgePanels", reason: "edit NodeForgePanels" }] };
      }
    }
  });
  const result = await service.createTicket({ projectId: "P1", content: "fix chat panel" });
  assert.equal(result.created, true);
  assert.equal(streamCalls, 0);
  assert.equal(resolveCalls, 0);
  assert.equal(seen.length, 1);
  assert.match(seen[0].correlationId, /^CORR-TICKET-CREATE-/);
  assert.deepEqual(result.ticket.candidate_files, [{ path: "ui/nextjs/components/NodeForgePanels.jsx", role: "PATCH", symbol: "NodeForgePanels", reason: "edit NodeForgePanels" }]);
  assert.equal(result.ticket.candidates_produced_by, "sprint-leader-sdk");
});

test("sdk sprint leader regen keeps verified candidates on the ticket", async () => {
  const { roadmaps } = createService();
  roadmaps.save({ id: "ROADMAP-P1", project_id: "P1", version: "1.0.0", created_at: "2026-09-13T00:00:00Z", sprints: [{ id: "SPRINT-P1-1", roadmap_id: "ROADMAP-P1", project_id: "P1", objective: "Sprint one", tickets: [{ id: "TICKET-1", project_id: "P1", roadmap_id: "ROADMAP-P1", sprint_id: "SPRINT-P1-1", title: "Báo cáo sprint", objective: "Hiển thị tiến độ", acceptance_criteria: ["Người dùng xem được tiến độ"], style: ["frontend"], candidate_files: [{ path: "ui/nextjs/components/NodeForgePanels.jsx", role: "REFERENCE", reason: "old" }], provenance: { source: "project_owner", source_id: "TICKET-1", created_at: "2026-09-13T00:00:00Z" } }], exit_criteria: ["done"] }] });
  const { createTicketCrudService: create } = await import("../../src/application/ticket-crud-service.js");
  const { createProseTicketService: createProse } = await import("../../src/application/prose-ticket-service.js");
  const prose = createProse({ roadmapStore: roadmaps });
  const svc = create({ roadmaps, proseTicketService: prose, agentRoleResolver: { resolve: () => "AGENT-SL-1" }, publisher: { publish: () => {} }, sprintLeader: { requestTicket: async () => ({ title: "Sprint progress report", objective: "Display progress", acceptance_criteria: ["Users can view progress"], style: ["frontend"], candidate_files: [{ path: "ui/nextjs/components/NodeForgePanels.jsx", role: "PATCH", symbol: "NodeForgePanels", reason: "edit NodeForgePanels" }] }) } });
  const result = await svc.regenerateTicketEnglish({ projectId: "P1", ticketId: "TICKET-1", context: "Tiêu đề: Báo cáo sprint" });
  assert.equal(result.updated, true);
  assert.equal(result.ticket.title, "Sprint progress report");
  assert.deepEqual(result.ticket.candidate_files, [{ path: "ui/nextjs/components/NodeForgePanels.jsx", role: "PATCH", symbol: "NodeForgePanels", reason: "edit NodeForgePanels" }]);
});
