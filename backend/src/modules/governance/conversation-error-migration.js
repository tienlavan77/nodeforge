// Migrates indexed historical conversation errors to the canonical envelope while preserving original JSONL evidence.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { normalizeErrorContract } from "../../shared/error-contract.js";

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

// Writes a separate canonical projection and switches indexed rows in one database transaction.
export async function migrateConversationErrors({ database, fileService, projectId, clock = () => new Date().toISOString() }) {
  if (!database?.all || !database?.transaction || !fileService?.readFileRangeSync || !fileService?.appendFileSync || !fileService?.atomicWrite || !projectId) throw new Error("Conversation error migration requires a project database and File Service.");
  const lock = await fileService.createLock({ path: ".forge/runtime/nf/error-migrations/migration.lock" });
  try {
    const rows = database.all("SELECT sequence,message_id,raw_file,byte_offset,byte_length FROM agent_communications WHERE project_id=? AND (message_type LIKE '%.error' OR message_type LIKE '%.failed') ORDER BY sequence", [projectId]);
    const pending = [];
    for (const row of rows) {
      const raw = fileService.readFileRangeSync({ path: join(".forge/runtime/nf", row.raw_file), offset: row.byte_offset, length: row.byte_length });
      const message = JSON.parse(raw);
      const payload = message.payload ?? {};
      if (!Object.hasOwn(payload, "error_code") && !Object.hasOwn(payload, "recoverable") && !Object.hasOwn(payload, "request_id")) continue;
      const code = payload.error_code ?? payload.code ?? "AGENT_ERROR";
      const error = normalizeErrorContract({ error: { code, message: String(payload.error ?? payload.message ?? "Agent request failed."), retryable: payload.retryable ?? payload.recoverable ?? !["VALIDATION_FAILED", "CONVERSATION_ARCHIVED", "PROVIDER_AUTH"].includes(code) }, requestId: message.correlation_id ?? payload.request_id ?? null });
      const next = { ...message, payload: { ...payload, error } };
      delete next.payload.error_code;
      delete next.payload.recoverable;
      delete next.payload.request_id;
      pending.push({ row, before: digest(raw), next });
    }
    if (!pending.length) return { project_id: projectId, migrated: 0, source_rows: rows.length };
    const id = `conversation-errors-${randomUUID()}`;
    const relativeFile = `conversation-migrations/${id}.jsonl`;
    const replacements = pending.map(({ row, before, next }) => {
      const line = `${JSON.stringify(next)}\n`;
      const location = fileService.appendFileSync({ path: join(".forge/runtime/nf", relativeFile), content: line });
      return { sequence: row.sequence, message_id: row.message_id, original_file: row.raw_file, original_offset: row.byte_offset, original_length: row.byte_length, before, after: digest(line), raw_file: relativeFile, byte_offset: location.byte_offset, byte_length: location.byte_length };
    });
    const manifestPath = `.forge/runtime/nf/error-migrations/${id}.json`;
    const manifest = { project_id: projectId, migration_id: id, status: "prepared", created_at: clock(), source_rows: rows.length, migrated: replacements.length, replacements };
    await fileService.atomicWrite({ path: manifestPath, content: `${JSON.stringify(manifest)}\n`, replace: false });
    database.transaction(() => {
      for (const row of replacements) {
        const result = database.run("UPDATE agent_communications SET raw_file=?,byte_offset=?,byte_length=? WHERE sequence=? AND message_id=? AND raw_file=? AND byte_offset=? AND byte_length=?", [row.raw_file, row.byte_offset, row.byte_length, row.sequence, row.message_id, row.original_file, row.original_offset, row.original_length]);
        if (result.changes !== 1) throw new Error(`Conversation error migration source changed: ${row.message_id}`);
      }
    });
    await fileService.atomicWrite({ path: manifestPath, content: `${JSON.stringify({ ...manifest, status: "completed", completed_at: clock() })}\n`, replace: true });
    return { project_id: projectId, migrated: replacements.length, source_rows: rows.length, migration_id: id, manifest_path: manifestPath };
  } finally { await lock.release(); }
}
