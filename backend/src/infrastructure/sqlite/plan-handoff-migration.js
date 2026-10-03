// Migrates plan paths and stores durable owner-approved Sprint Leader handoff receipts.
export const planHandoffMigration = {
  version: 14,
  statements: [
    "UPDATE plan_revisions SET file_path = replace(file_path, '.forge/plans/', '.forge/runtime/nf/plans/') WHERE file_path LIKE '.forge/plans/%'",
    "UPDATE sprint_registry SET plan_path = replace(plan_path, '.forge/plans/', '.forge/runtime/nf/plans/') WHERE plan_path LIKE '.forge/plans/%'",
    `CREATE TABLE plan_handoffs (
      plan_id TEXT NOT NULL, revision INTEGER NOT NULL, project_id TEXT NOT NULL,
      sha256 TEXT NOT NULL, status TEXT NOT NULL, sprint_id TEXT,
      generated_json TEXT,
      error_code TEXT, error_message TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY(plan_id, revision),
      FOREIGN KEY(plan_id, revision) REFERENCES plan_revisions(plan_id, revision)
    )`
  ]
};
