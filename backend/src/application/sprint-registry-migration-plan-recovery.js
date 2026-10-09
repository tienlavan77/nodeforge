// Recovers migration-owned immutable plan files left unindexed by a crash without importing approval decisions.
import { createHash } from "node:crypto";
import { migrationError, migrationHash } from "./sprint-registry-migration-preview.js";

// Adopts only an exact first revision produced for this migration entry; unrelated files remain untouched.
export async function recoverSprintMigrationPlan({ projectId, entry, database, fileService, plans }) {
  const path = `.forge/runtime/nf/plans/${entry.plan_id}/1.json`;
  let bytes;
  try { bytes = await fileService.readFile({ path }); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const artifact = JSON.parse(bytes);
  if (artifact.plan_id !== entry.plan_id || artifact.project_id !== projectId || artifact.sprint_id !== entry.sprint_id || artifact.revision !== 1 || artifact.proposal_id !== null || artifact.source_path || artifact.source_sha256 || !Number.isFinite(Date.parse(artifact.created_at)) || migrationHash(artifact.content) !== migrationHash(entry.content)) throw migrationError("SPRINT_MIGRATION_ORPHAN_CONFLICT", "Unindexed plan file does not match the migration's exact scope.");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  database.transaction(() => {
    if (database.all("SELECT plan_id FROM plan_heads WHERE plan_id=?", [entry.plan_id]).length || database.all("SELECT plan_id FROM plan_revisions WHERE plan_id=?", [entry.plan_id]).length) throw migrationError("SPRINT_MIGRATION_ORPHAN_CONFLICT", "Orphan plan identity is already indexed; reconcile it before importing.");
    database.run("INSERT INTO plan_revisions(plan_id,revision,project_id,sprint_id,file_path,sha256,created_at) VALUES (?,?,?,?,?,?,?)", [entry.plan_id, 1, projectId, entry.sprint_id, path, sha256, artifact.created_at]);
    database.run("INSERT INTO plan_heads(plan_id,project_id,revision) VALUES (?,?,?)", [entry.plan_id, projectId, 1]);
  });
  return plans.getRevision({ planId: entry.plan_id, revision: 1 });
}
