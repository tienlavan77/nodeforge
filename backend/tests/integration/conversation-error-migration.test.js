// Proves historical error messages gain canonical indexed projections without changing their original audit bytes.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { migrateConversationErrors } from "../../src/modules/governance/conversation-error-migration.js";
import { projectConversationMessages } from "../../src/transport/sse/project-stream-conversation.js";

test("migration preserves raw history and switches only indexed legacy errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-error-migration-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime/nf"), runtimeDir: "." });
  try {
    const fileService = createFileService({ projectRoot: root });
    const store = createAgentCommunicationStore({ database, fileService });
    store.append({ id: "MSG-LEGACY", project_id: "PROJECT-A", sender: { id: "AGENT-A", role: "runtime" }, recipient: { id: "NODE", role: "node" }, message_type: "architecture.error", conversation_id: "CONV-A", correlation_id: "REQ-A", payload: { error: "Legacy failed", error_code: "LEGACY_FAILURE", agent_status: "FAILED" }, timestamp: "2026-09-30T00:00:00Z" });
    const prior = database.all("SELECT raw_file,byte_offset,byte_length FROM agent_communications WHERE message_id='MSG-LEGACY'")[0];
    const original = fileService.readFileRangeSync({ path: join(".forge/runtime/nf", prior.raw_file), offset: prior.byte_offset, length: prior.byte_length });
    const result = await migrateConversationErrors({ database, fileService, projectId: "PROJECT-A" });
    assert.equal(result.migrated, 1);
    const migrated = store.getById("MSG-LEGACY");
    assert.equal(migrated.payload.error.code, "legacy_failure");
    assert.equal(migrated.payload.error.requestId, "REQ-A");
    assert.equal(Object.hasOwn(migrated.payload, "error_code"), false);
    assert.equal(projectConversationMessages(migrated)[0].payload.error.code, "legacy_failure");
    assert.equal(fileService.readFileRangeSync({ path: join(".forge/runtime/nf", prior.raw_file), offset: prior.byte_offset, length: prior.byte_length }), original);
    assert.equal((await migrateConversationErrors({ database, fileService, projectId: "PROJECT-A" })).migrated, 0);
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});
