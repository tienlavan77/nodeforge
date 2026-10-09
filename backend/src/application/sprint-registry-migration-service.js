// Imports source-bound legacy Sprints additively during maintenance, retaining legacy data and requiring fresh approval.
import { buildSprintMigrationPreview, migrationError, migrationHash } from "./sprint-registry-migration-preview.js";

// Provides preview and guarded apply with backup-before-write and repeatable partial-import recovery.
export function createSprintRegistryMigrationService({ projectId, readSource, registry, plans, recoverPlan, withMaintenance, backup, writeReceipt }) {
  if (!projectId || !readSource || !registry?.list || !plans?.createRevision) throw migrationError("SPRINT_MIGRATION_CONFIG", "Migration requires a project, source reader, Registry and Plan Store.");
  return Object.freeze({ preview, apply });

  // Reads only source and scheduling evidence; missing human scope remains an explicit blocker.
  async function preview({ project_id, supplements = {} } = {}) {
    assertProject(project_id);
    return buildSprintMigrationPreview({ projectId, source: await readSource(), registryRecords: registry.list(), supplements });
  }

  // Refuses cross-project migration even when an operator has supplied a valid-looking manifest.
  function assertProject(value) {
    if (value !== projectId) throw migrationError("SPRINT_MIGRATION_PROJECT", "Migration project differs from the configured runtime.");
  }

  // Revalidates the immutable preview, allowing only exact imports from that manifest on a resumed run.
  async function validate(manifest) {
    assertProject(manifest?.project_id);
    const source = await readSource();
    const { manifest_sha256, can_apply, ...basis } = manifest;
    if (migrationHash(basis) !== manifest_sha256 || !can_apply || basis.blockers?.length) throw migrationError("SPRINT_MIGRATION_MANIFEST", "Preview is invalid or has unresolved blockers.");
    const current = registry.list();
    const importedIds = new Set(manifest.entries.map((entry) => entry.sprint_id));
    if (migrationHash(current.filter((record) => !importedIds.has(record.sprint_id))) !== manifest.registry_sha256) throw migrationError("SPRINT_MIGRATION_STALE", "Registry changed after preview.");
    const rebuilt = buildSprintMigrationPreview({ projectId, source, registryRecords: current.filter((record) => !importedIds.has(record.sprint_id)), supplements: manifest.supplements });
    if (rebuilt.manifest_sha256 !== manifest_sha256) throw migrationError("SPRINT_MIGRATION_STALE", "Source or migration scope changed after preview.");
    for (const entry of manifest.entries) {
      const record = registry.get(entry.sprint_id);
      if (!record) continue;
      const plan = await plans.getRevision({ planId: entry.plan_id, revision: 1 });
      if (record.plan_id !== entry.plan_id || record.plan_revision !== 1 || record.plan_sha256 !== plan.sha256 || record.plan_path !== plan.file_path || record.position !== entry.position || record.version !== 0 || record.status !== "awaiting_human_approval" || migrationHash(record.dependencies) !== migrationHash(entry.dependencies) || plan.status !== "awaiting_human_approval" || migrationHash(plan.content) !== migrationHash(entry.content)) throw migrationError("SPRINT_MIGRATION_CONFLICT", "Imported Sprint changed; automatic recovery cannot overwrite it.");
    }
    return source;
  }

  // Executes imports only while a trusted maintenance adapter holds the runtime's exclusive lock.
  async function apply({ project_id, manifest, manifest_sha256 } = {}) {
    assertProject(project_id);
    if (manifest?.manifest_sha256 !== manifest_sha256) throw migrationError("SPRINT_MIGRATION_MANIFEST", "Apply requires the exact preview checksum.");
    if (!withMaintenance || !backup || !writeReceipt || !recoverPlan) throw migrationError("SPRINT_MIGRATION_MAINTENANCE_REQUIRED", "Apply needs an exclusive maintenance adapter, backup, receipt writer and orphan recovery.");
    return withMaintenance(async () => {
      const source = await validate(manifest);
      const backupEvidence = await backup({ manifest, source });
      if (!backupEvidence?.path || !backupEvidence?.sha256) throw migrationError("SPRINT_MIGRATION_BACKUP_REQUIRED", "A verifiable backup is required before import.");
      await validate(manifest);
      const imported = [];
      for (const entry of manifest.entries) {
        if (registry.get(entry.sprint_id)) { imported.push(registry.get(entry.sprint_id)); continue; }
        const head = plans.list().find((item) => item.plan_id === entry.plan_id);
        let plan = head ? await plans.getRevision({ planId: entry.plan_id, revision: head.revision }) : await recoverPlan(entry);
        if (!plan) plan = await plans.createRevision({ planId: entry.plan_id, sprintId: entry.sprint_id, expectedRevision: 0, content: entry.content });
        if (plan.project_id !== projectId || plan.sprint_id !== entry.sprint_id || plan.revision !== 1 || plan.status !== "awaiting_human_approval" || migrationHash(plan.content) !== migrationHash(entry.content)) throw migrationError("SPRINT_MIGRATION_PLAN_CONFLICT", "Existing plan differs from the migration scope or already has a decision.");
        imported.push(await registry.register({ sprintId: entry.sprint_id, position: entry.position, dependencies: entry.dependencies, planId: plan.plan_id, revision: 1 }));
      }
      const receipt = { project_id: projectId, manifest_sha256, backup: backupEvidence, imported, completed_at: new Date().toISOString(), approval_granted: false, execution_started: false };
      const receiptPath = await writeReceipt(receipt);
      return { ...receipt, receipt_path: receiptPath };
    });
  }
}
