// Maintains the project business database independently from the rebuildable search index.
// Each control schema revision and its marker commit together so interrupted upgrades can
// be retried without losing existing Ideas or unrelated project business records.

/** Applies the first control schema revision atomically, preserving existing tables and data. */
export function runControlMigrations(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("CREATE TABLE IF NOT EXISTS control_schema_migrations (version INTEGER PRIMARY KEY)");
    const current = database.prepare("SELECT MAX(version) AS version FROM control_schema_migrations").get().version ?? 0;
    if (current < 1) {
      database.exec(`CREATE TABLE ideas (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
        PRIMARY KEY (project_id, id)
      )`);
      database.exec("CREATE INDEX ideas_by_project_status ON ideas (project_id, status, created_at, id)");
      database.prepare("INSERT INTO control_schema_migrations (version) VALUES (?)").run(1);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
