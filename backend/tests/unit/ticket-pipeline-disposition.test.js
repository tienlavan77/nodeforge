// Proves legacy owner decisions are durable, evidence-bound, and block unsafe enforce.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketPipelineDisposition } from "../../src/modules/supervisor/ticket-pipeline-disposition.js";
import { createTicketPipelineRollout } from "../../src/modules/supervisor/ticket-pipeline-rollout.js";

test("legacy disposition requires an owner and current evidence before enforce", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-disposition-"));
  try {
    const fileService = createFileService({ projectRoot: root });
    let ticket = { task_id: "TICKET-OLD", classification: "human-review-required", context: false, ledger: true, reasons: ["pre_context_activity"] };
    const inventory = { inspect: async () => ({ project_id: "PROJECT-A", tickets: [ticket] }) };
    const disposition = createTicketPipelineDisposition({ projectId: "PROJECT-A", fileService, inventory });
    const rollout = createTicketPipelineRollout({ projectId: "PROJECT-A", fileService, inventory, disposition, releaseGate: { verify: async () => ({ approved: true, project_id: "PROJECT-A" }) } });
    const fingerprint = (await disposition.inspect()).tickets[0].inventory_fingerprint;
    await assert.rejects(rollout.setMode("enforce", 0), { code: "TICKET_PIPELINE_DISPOSITION_REQUIRED" });
    await assert.rejects(disposition.decide({ taskId: ticket.task_id, disposition: "migrated", actorId: "OWNER-1", actorRole: "human", evidenceRefs: ["receipt-1"], expectedFingerprint: fingerprint }), { code: "TICKET_DISPOSITION_MIGRATION_UNPROVEN" });
    const input = { taskId: ticket.task_id, disposition: "needs_human_review", actorId: "OWNER-1", actorRole: "human", expectedFingerprint: fingerprint };
    const saved = await disposition.decide(input);
    assert.deepEqual(await disposition.decide(input), saved);
    assert.equal((await disposition.inspect()).tickets[0].reason, "human_review_pending");
    await assert.rejects(rollout.setMode("enforce", 0), { code: "TICKET_PIPELINE_DISPOSITION_REQUIRED" });
    ticket = { ...ticket, reasons: ["pre_context_activity", "new_evidence"] };
    assert.equal((await disposition.inspect()).tickets[0].reason, "stale_disposition");
    await assert.rejects(disposition.decide(input), { code: "TICKET_DISPOSITION_STALE" });
    assert.equal((await createTicketPipelineDisposition({ projectId: "PROJECT-A", fileService, inventory }).inspect()).tickets[0].blocked, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owner cancellation remains visible after the legacy inventory changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-disposition-cancel-"));
  try {
    const fileService = createFileService({ projectRoot: root });
    let ticket = { task_id: "TICKET-OLD", classification: "human-review-required", context: true, ledger: true, reasons: ["pre_context_activity"] };
    const inventory = { inspect: async () => ({ project_id: "PROJECT-A", tickets: [ticket] }) };
    const disposition = createTicketPipelineDisposition({ projectId: "PROJECT-A", fileService, inventory });
    const fingerprint = (await disposition.inspect()).tickets[0].inventory_fingerprint;
    await disposition.decide({ taskId: ticket.task_id, disposition: "cancelled", actorId: "PROJECT-OWNER", actorRole: "human", evidenceRefs: ["owner-decision"], expectedFingerprint: fingerprint });
    ticket = { ...ticket, reasons: ["pre_context_activity", "new_evidence"] };
    assert.equal((await disposition.inspect()).tickets[0].reason, "stale_disposition");
    assert.equal((await disposition.get(ticket.task_id)).disposition, "cancelled");
  } finally { await rm(root, { recursive: true, force: true }); }
});
