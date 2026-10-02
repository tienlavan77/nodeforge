// Verifies durable ticket integration receipts across prepared and completed phases.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTerminalReceiptWriter } from "../../src/modules/supervisor/terminal-receipt-writer.js";

test("terminal receipt writer persists phases and excludes unfinished receipts from the terminal gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-terminal-receipt-"));
  try {
    const fileService = createFileService({ projectRoot: root });
    const writer = createTerminalReceiptWriter({ fileService });
    const state = { task_id: "TICKET-A", branch: "ui-chat", previous_head: "before", reviewed_commit: "reviewed", commit: "reviewed", artifact_id: "ARTIFACT-A", tree_sha: "tree", manifest_sha: "manifest", source_revision: "revision", base_sha: "base", workspace_mode: "root-only", supervisor_id: null, recorded_at: new Date().toISOString() };
    assert.equal(await writer.load("TICKET-A"), null);
    await writer.savePrepared("TICKET-A", state);
    assert.equal((await writer.load("TICKET-A")).status, "prepared");
    assert.equal(await writer.loadIfCompleted("TICKET-A"), null);
    await assert.rejects(writer.saveCompleted("TICKET-A", { ...state, manifest_sha: "different" }), { code: "TICKET_RECEIPT_CONFLICT" });
    await writer.saveCompleted("TICKET-A", state);
    assert.equal((await writer.loadIfCompleted("TICKET-A")).reviewed_commit, "reviewed");
    await assert.rejects(writer.saveCompleted("TICKET-B", state), { code: "TICKET_RECEIPT_INVALID" });
    await fileService.atomicWrite({ path: writer.path("TICKET-A"), content: "null", replace: true });
    await assert.rejects(writer.load("TICKET-A"), { code: "TICKET_RECEIPT_INVALID" });
    assert.throws(() => writer.path("../outside"), { code: "TICKET_RECEIPT_ID_INVALID" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
