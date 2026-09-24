import assert from "node:assert/strict";
import test from "node:test";

import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createProseTicketService } from "../../src/application/prose-ticket-service.js";
import { createTicketCrudService } from "../../src/application/ticket-crud-service.js";

// Covers legacy text-only regen: the leader has no codebase access, so its
// output is validated and persisted without invented paths.
function createService({ agentStream, agentRoleResolver, candidateResolver, sprintLeader } = {}) {
  const roadmaps = createRoadmapStore({});
  const proseTicketService = createProseTicketService({ roadmapStore: roadmaps });
  const service = createTicketCrudService({ roadmaps, proseTicketService, agentStream, agentRoleResolver, candidateResolver, sprintLeader });
  return { roadmaps, service };
}

test("regenerates an existing ticket in English from Vietnamese context via the sprint leader", async () => {
  const prompts = [];
  const ticketFileUpdates = [];
  const Vietnamese = "Tiêu đề: Báo cáo sprint\nMục tiêu: Hiển thị tiến độ\nTiêu chí: Người dùng xem được tiến độ";
  const { roadmaps } = createService({
    agentStream: async function* ({ agentId, payload }) {
      assert.equal(agentId, "AGENT-SL-1");
      prompts.push(payload.text);
      yield { text: '```json\n{"title":"Sprint progress report","objective":"Display progress","acceptance_criteria":["Users can view progress"],"priority":"high"}\n```' };
    },
    agentRoleResolver: { resolve: (role) => { assert.equal(role, "sprint_leader"); return "AGENT-SL-1"; } }
  });
  roadmaps.save({ id: "ROADMAP-P1", project_id: "P1", version: "1.0.0", created_at: "2026-09-13T00:00:00Z", sprints: [{ id: "SPRINT-P1-1", roadmap_id: "ROADMAP-P1", project_id: "P1", objective: "Sprint one", tickets: [{ id: "TICKET-1", project_id: "P1", roadmap_id: "ROADMAP-P1", sprint_id: "SPRINT-P1-1", title: "Báo cáo sprint", objective: "Hiển thị tiến độ", acceptance_criteria: ["Người dùng xem được tiến độ"], provenance: { source: "project_owner", source_id: "TICKET-1", created_at: "2026-09-13T00:00:00Z" } }], exit_criteria: ["done"] }] });
  // Direct exercise of regenerateTicketEnglish with a ticket file store to verify file sync
  const fileRoadmaps = roadmaps;
  // Re-create service with ticketFileStore to verify file sync
  const { createTicketCrudService: create } = await import("../../src/application/ticket-crud-service.js");
  const { createProseTicketService: createProse } = await import("../../src/application/prose-ticket-service.js");
  const prose = createProse({ roadmapStore: fileRoadmaps });
  const svcWithStore = create({ roadmaps: fileRoadmaps, proseTicketService: prose, agentStream: async function* ({ payload }) { prompts.push(payload.text); yield { text: '```json\n{"title":"Sprint progress report","objective":"Display progress","acceptance_criteria":["Users can view progress"]}\n```' }; }, agentRoleResolver: { resolve: () => "AGENT-SL-1" }, ticketFileStore: { create: () => {}, update: (arg) => { ticketFileUpdates.push({ title: arg.ticket.title, context: arg.context }); return true; } }, publisher: { publish: () => {} } });
  const result = await svcWithStore.regenerateTicketEnglish({ projectId: "P1", ticketId: "TICKET-1", context: Vietnamese });
  assert.equal(result.ticket.id, "TICKET-1");
  assert.equal(result.ticket.title, "Sprint progress report");
  assert.equal(result.updated, true);
  assert.match(prompts[0], /TICKET-1/);
  assert.match(prompts[0], /Báo cáo sprint/);
  assert.deepEqual(ticketFileUpdates, [{ title: "Sprint progress report", context: Vietnamese }]);
  // No duplicate ticket created
  assert.equal(fileRoadmaps.getCurrent().sprints[0].tickets.length, 1);
});

test("regeneration fails without losing ticket when leader returns invalid English content", async () => {
  const { roadmaps } = createService();
  roadmaps.save({ id: "ROADMAP-P1", project_id: "P1", version: "1.0.0", created_at: "2026-09-13T00:00:00Z", sprints: [{ id: "SPRINT-P1-1", roadmap_id: "ROADMAP-P1", project_id: "P1", objective: "Sprint one", tickets: [{ id: "TICKET-1", project_id: "P1", roadmap_id: "ROADMAP-P1", sprint_id: "SPRINT-P1-1", title: "Báo cáo sprint", objective: "Hiển thị tiến độ", acceptance_criteria: ["Người dùng xem được tiến độ"], provenance: { source: "project_owner", source_id: "TICKET-1", created_at: "2026-09-13T00:00:00Z" } }], exit_criteria: ["done"] }] });
  const { createTicketCrudService: create } = await import("../../src/application/ticket-crud-service.js");
  const { createProseTicketService: createProse } = await import("../../src/application/prose-ticket-service.js");
  const prose = createProse({ roadmapStore: roadmaps });
  const svc = create({ roadmaps, proseTicketService: prose, agentStream: async function* () { yield { text: '```json\n{"title":"","objective":"","acceptance_criteria":[]}\n```' }; }, agentRoleResolver: { resolve: () => "AGENT-SL-1" }, publisher: { publish: () => {} } });
  await assert.rejects(() => svc.regenerateTicketEnglish({ projectId: "P1", ticketId: "TICKET-1", context: "Nội dung tiếng Việt" }), (e) => e.code === "INVALID_REGENERATED_TICKET");
  assert.equal(roadmaps.getCurrent().sprints[0].tickets[0].title, "Báo cáo sprint");
});
