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
    if (current < 2) {
      database.exec(`CREATE TABLE idea_deletions (
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
        PRIMARY KEY (project_id, id)
      )`);
      database.exec("CREATE INDEX IF NOT EXISTS idx_idea_deletions_project_deleted ON idea_deletions (project_id, id)");
      database.prepare("INSERT INTO control_schema_migrations (version) VALUES (?)").run(2);
    }
    if (current < 3) {
      const hasIdeas = Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ideas'").get());
      if (hasIdeas) {
        const hasPosition = database.prepare("PRAGMA table_info(ideas)").all().some((col) => col.name === "position");
        if (!hasPosition) {
          database.exec("ALTER TABLE ideas ADD COLUMN position INTEGER NOT NULL DEFAULT 0 CHECK (typeof(position) = 'integer' AND position >= 0)");
        }
        database.exec("CREATE INDEX IF NOT EXISTS ideas_by_project_position ON ideas (project_id, position, created_at, id)");
      }
      database.prepare("INSERT INTO control_schema_migrations (version) VALUES (?)").run(3);
    }
    if (current < 4) {
      const hasIdeas = Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ideas'").get());
      const hasNotebooks = Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notebooks'").get());
      const hasIdeaDeletions = Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'idea_deletions'").get());
      const hasNotebookDeletions = Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notebook_deletions'").get());

      if (hasIdeas) {
        if (!hasNotebooks) {
          database.exec("ALTER TABLE ideas RENAME TO notebooks");
        } else {
          const ideasHasPosition = database.prepare("PRAGMA table_info(ideas)").all().some((col) => col.name === "position");
          database.exec(`INSERT OR IGNORE INTO notebooks (id, project_id, content, status, created_at, updated_at, version, position)
            SELECT id, project_id, content, status, created_at, updated_at, version, ${ideasHasPosition ? "position" : "0"} FROM ideas`);
          database.exec("DROP TABLE ideas");
        }
        database.exec("DROP INDEX IF EXISTS ideas_by_project_status");
        database.exec("DROP INDEX IF EXISTS ideas_by_project_position");
        database.exec("DROP INDEX IF EXISTS idx_ideas_project_updated");
        database.exec("DROP INDEX IF EXISTS idx_ideas_project_position");
        if (hasIdeaDeletions) {
          if (!hasNotebookDeletions) {
            database.exec("ALTER TABLE idea_deletions RENAME TO notebook_deletions");
          } else {
            database.exec(`INSERT OR IGNORE INTO notebook_deletions (project_id, id, version)
              SELECT project_id, id, version FROM idea_deletions`);
            database.exec("DROP TABLE idea_deletions");
          }
          database.exec("DROP INDEX IF EXISTS idx_idea_deletions_project_deleted");
        } else if (!hasNotebookDeletions) {
          database.exec(`CREATE TABLE notebook_deletions (
            project_id TEXT NOT NULL,
            id TEXT NOT NULL,
            version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
            PRIMARY KEY (project_id, id)
          )`);
        }
      } else if (!hasNotebooks) {
        database.exec(`CREATE TABLE notebooks (
          id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
          position INTEGER NOT NULL DEFAULT 0 CHECK (typeof(position) = 'integer' AND position >= 0),
          PRIMARY KEY (project_id, id)
        )`);
        database.exec(`CREATE TABLE notebook_deletions (
          project_id TEXT NOT NULL,
          id TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
          PRIMARY KEY (project_id, id)
        )`);
      }
      const hasNotebooksNow = Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notebooks'").get());
      const hasNotebookDeletionsNow = Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notebook_deletions'").get());

      if (hasNotebooksNow) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_notebooks_project_updated ON notebooks (project_id, status, created_at, id)");
        database.exec("CREATE INDEX IF NOT EXISTS idx_notebooks_project_position ON notebooks (project_id, position, created_at, id)");
      }
      if (hasNotebookDeletionsNow) {
        database.exec("CREATE INDEX IF NOT EXISTS idx_notebook_deletions_project_deleted ON notebook_deletions (project_id, id)");
      }
      database.prepare("INSERT INTO control_schema_migrations (version) VALUES (?)").run(4);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
