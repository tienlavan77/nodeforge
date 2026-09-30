// Proves immutable ticket gates cannot be enabled for a project with unresolved legacy evidence.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketPipelineRollout } from "../../src/modules/supervisor/ticket-pipeline-rollout.js";

// Persists the project flag through Forge File Service and refuses stale CAS or legacy bypass.
test("rollout remains shadow until legacy tickets are resolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-pipeline-rollout-"));
  try {
    const files = createFileService({ projectRoot: root });
    let tickets = [{ task_id: "TICKET-OLD", classification: "human-review-required" }];
    const inventory = { inspect: async () => ({ project_id: "PROJECT-A", tickets }) };
    const disposition = { inspect: async () => ({ project_id: "PROJECT-A", tickets: tickets.map((ticket) => ({ task_id: ticket.task_id, blocked: true })) }) };
    const releaseGate = { verify: async () => ({ approved: true, project_id: "PROJECT-A" }) };
    const rollout = createTicketPipelineRollout({ projectId: "PROJECT-A", fileService: files, inventory, disposition, releaseGate });
    assert.equal((await rollout.load()).mode, "shadow");
    assert.deepEqual((await rollout.shadowAudit()).classifications, { migratable: 0, stale: 0, "human-review-required": 1 });
    await assert.rejects(rollout.setMode("enforce", 0), { code: "TICKET_PIPELINE_DISPOSITION_REQUIRED" });
    tickets = [];
    await assert.rejects(createTicketPipelineRollout({ projectId: "PROJECT-A", fileService: files, inventory, disposition }).setMode("enforce", 0), { code: "TICKET_PIPELINE_RELEASE_REQUIRED" });
    assert.equal((await rollout.setMode("enforce", 0)).mode, "enforce");
    assert.equal((await createTicketPipelineRollout({ projectId: "PROJECT-A", fileService: files, inventory, disposition }).load()).version, 1);
    await assert.rejects(rollout.setMode("shadow", 0), { code: "TICKET_PIPELINE_FLAG_CONFLICT" });
    assert.equal((await rollout.setMode("shadow", 1)).mode, "shadow");
  } finally { await rm(root, { recursive: true, force: true }); }
});
