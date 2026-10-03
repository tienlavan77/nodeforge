// Binds Sprint Leader's JSON projection to the exact owner-approved Markdown revision.
export const derivedPlanMigration = {
  version: 16,
  statements: [`CREATE TABLE derived_plan_approvals (
    plan_id TEXT NOT NULL, revision INTEGER NOT NULL, sha256 TEXT NOT NULL,
    markdown_plan_id TEXT NOT NULL, markdown_revision INTEGER NOT NULL,
    markdown_sha256 TEXT NOT NULL, markdown_decision_id TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(plan_id, revision),
    FOREIGN KEY(plan_id, revision) REFERENCES plan_revisions(plan_id, revision),
    FOREIGN KEY(markdown_plan_id, markdown_revision) REFERENCES markdown_plan_revisions(plan_id, revision)
  )`]
};

// Keeps the originating conversation attached to readable plans across UI reloads.
export const markdownConversationMigration = { version: 17, statements: ["ALTER TABLE markdown_plan_revisions ADD COLUMN conversation_id TEXT"] };
