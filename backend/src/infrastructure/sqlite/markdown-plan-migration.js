// Stores human-readable plan approvals separately from executable JSON revisions.
export const markdownPlanMigration = {
  version: 15,
  statements: [
    `CREATE TABLE markdown_plan_revisions (
      plan_id TEXT NOT NULL, revision INTEGER NOT NULL, project_id TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,
      summary_path TEXT NOT NULL, summary_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(plan_id, revision)
    )`,
    `CREATE TABLE markdown_plan_decisions (
      decision_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
      sha256 TEXT NOT NULL, decision TEXT NOT NULL, approver_id TEXT NOT NULL,
      comments TEXT, decided_at TEXT NOT NULL,
      FOREIGN KEY(plan_id, revision) REFERENCES markdown_plan_revisions(plan_id, revision)
    )`,
    "CREATE INDEX markdown_plan_decisions_revision ON markdown_plan_decisions (plan_id, revision, decided_at)",
    `CREATE TABLE markdown_plan_handoffs (
      plan_id TEXT NOT NULL, revision INTEGER NOT NULL, project_id TEXT NOT NULL,
      sha256 TEXT NOT NULL, status TEXT NOT NULL, sprint_id TEXT,
      generated_json TEXT, error_code TEXT, error_message TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY(plan_id, revision),
      FOREIGN KEY(plan_id, revision) REFERENCES markdown_plan_revisions(plan_id, revision)
    )`
  ]
};
