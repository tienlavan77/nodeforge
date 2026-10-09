// Defines additive Sprint Registry versioning and preserves historical plan/scheduling migrations.
export const humanPlanMigration = {
  version: 11,
  statements: [
    `CREATE TABLE plan_revisions (
      plan_id TEXT NOT NULL, revision INTEGER NOT NULL, project_id TEXT NOT NULL,
      sprint_id TEXT, file_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY (plan_id, revision)
    )`,
    `CREATE TABLE plan_heads (
      plan_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
      FOREIGN KEY (plan_id, revision) REFERENCES plan_revisions(plan_id, revision)
    )`,
    `CREATE TABLE plan_decisions (
      decision_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
      sha256 TEXT NOT NULL, decision TEXT NOT NULL, approver_id TEXT NOT NULL,
      comments TEXT, decided_at TEXT NOT NULL,
      FOREIGN KEY (plan_id, revision) REFERENCES plan_revisions(plan_id, revision)
    )`,
    "CREATE INDEX plan_decisions_revision ON plan_decisions (plan_id, revision, decided_at)",
    `CREATE TABLE sprint_registry (
      sprint_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, position INTEGER NOT NULL,
      dependencies_json TEXT NOT NULL, status TEXT NOT NULL, plan_id TEXT NOT NULL,
      plan_revision INTEGER NOT NULL, plan_path TEXT NOT NULL, plan_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (plan_id, plan_revision) REFERENCES plan_revisions(plan_id, revision),
      UNIQUE (project_id, position)
    )`,
    "CREATE INDEX sprint_registry_project ON sprint_registry (project_id, position)"
  ]
};

export const unboundSprintMigration = {
  version: 12,
  statements: [
    "ALTER TABLE sprint_registry RENAME TO sprint_registry_v11",
    `CREATE TABLE sprint_registry (
      sprint_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, position INTEGER NOT NULL,
      dependencies_json TEXT NOT NULL, status TEXT NOT NULL, plan_id TEXT,
      plan_revision INTEGER, plan_path TEXT, plan_sha256 TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (plan_id, plan_revision) REFERENCES plan_revisions(plan_id, revision),
      UNIQUE (project_id, position)
    )`,
    "INSERT INTO sprint_registry (sprint_id,project_id,position,dependencies_json,status,plan_id,plan_revision,plan_path,plan_sha256,created_at,updated_at) SELECT sprint_id,project_id,position,dependencies_json,status,plan_id,plan_revision,plan_path,plan_sha256,created_at,updated_at FROM sprint_registry_v11",
    "DROP TABLE sprint_registry_v11",
    "CREATE INDEX sprint_registry_project ON sprint_registry (project_id, position)"
  ]
};

export const sprintRegistryArchiveMigration = {
  version: 19,
  statements: ["CREATE TABLE sprint_registry_archives (sprint_id TEXT PRIMARY KEY REFERENCES sprint_registry(sprint_id), project_id TEXT NOT NULL, archived_at TEXT NOT NULL, record_json TEXT NOT NULL)"]
};

export const sprintRegistryVersionMigration = {
  version: 18,
  statements: ["ALTER TABLE sprint_registry ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)"]
};
