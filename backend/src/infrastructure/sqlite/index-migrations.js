// Applies ordered SQLite schema migrations required for project code graph storage.
const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE files (
        file_id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        language TEXT,
        sha256 TEXT,
        size_bytes INTEGER,
        indexed_at TEXT NOT NULL
      )`,
      `CREATE TABLE symbols (
        symbol_id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        FOREIGN KEY (file_id) REFERENCES files(file_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE imports_exports (
        relation_id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL,
        related_file_id TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        FOREIGN KEY (file_id) REFERENCES files(file_id) ON DELETE CASCADE,
        FOREIGN KEY (related_file_id) REFERENCES files(file_id) ON DELETE SET NULL
      )`,
      `CREATE TABLE calls (
        call_id TEXT PRIMARY KEY,
        source_file_id TEXT NOT NULL,
        target_symbol_id TEXT,
        line INTEGER,
        FOREIGN KEY (source_file_id) REFERENCES files(file_id) ON DELETE CASCADE,
        FOREIGN KEY (target_symbol_id) REFERENCES symbols(symbol_id) ON DELETE SET NULL
      )`,
      `CREATE TABLE "references" (
        reference_id TEXT PRIMARY KEY,
        source_file_id TEXT NOT NULL,
        target_symbol_id TEXT,
        line INTEGER,
        FOREIGN KEY (source_file_id) REFERENCES files(file_id) ON DELETE CASCADE,
        FOREIGN KEY (target_symbol_id) REFERENCES symbols(symbol_id) ON DELETE SET NULL
      )`,
      `CREATE TABLE tests_map (
        test_id TEXT PRIMARY KEY,
        test_file_id TEXT NOT NULL,
        source_file_id TEXT NOT NULL,
        test_name TEXT,
        FOREIGN KEY (test_file_id) REFERENCES files(file_id) ON DELETE CASCADE,
        FOREIGN KEY (source_file_id) REFERENCES files(file_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE dependency_edges (
        source_file_id TEXT NOT NULL,
        target_file_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (source_file_id, target_file_id, kind),
        FOREIGN KEY (source_file_id) REFERENCES files(file_id) ON DELETE CASCADE,
        FOREIGN KEY (target_file_id) REFERENCES files(file_id) ON DELETE CASCADE
      )`
    ]
  },
  {
    version: 2,
    statements: [
      "ALTER TABLE imports_exports ADD COLUMN is_broken INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE dependency_edges RENAME TO dependency_edges_legacy",
      `CREATE TABLE dependency_edges (
        source_file_id TEXT NOT NULL,
        target_file_id TEXT,
        kind TEXT NOT NULL,
        is_broken INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_file_id, target_file_id, kind),
        FOREIGN KEY (source_file_id) REFERENCES files(file_id) ON DELETE CASCADE,
        FOREIGN KEY (target_file_id) REFERENCES files(file_id) ON DELETE SET NULL
      )`,
      "INSERT INTO dependency_edges (source_file_id, target_file_id, kind) SELECT source_file_id, target_file_id, kind FROM dependency_edges_legacy",
      "DROP TABLE dependency_edges_legacy"
    ]
  },
  {
    version: 3,
    statements: [
      "ALTER TABLE calls ADD COLUMN caller_symbol_id TEXT REFERENCES symbols(symbol_id) ON DELETE SET NULL"
    ]
  },
  {
    version: 4,
    statements: [
      "CREATE TABLE index_metadata (version INTEGER NOT NULL)",
      "INSERT INTO index_metadata (version) VALUES (0)"
    ]
  },
  {
    version: 5,
    statements: [
      "CREATE VIRTUAL TABLE file_content_fts USING fts5(file_id UNINDEXED, path, language, content)",
      "CREATE VIRTUAL TABLE symbol_content_fts USING fts5(symbol_id UNINDEXED, file_id UNINDEXED, path, name, kind, content, start_line UNINDEXED, end_line UNINDEXED)"
    ]
  },
  {
    version: 6,
    statements: [
      `CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      "CREATE INDEX conversations_project_agent ON conversations (project_id, agent_id, updated_at)",
      "CREATE INDEX conversations_project ON conversations (project_id, updated_at)"
    ]
  },
  {
    version: 7,
    statements: [
      `CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        roadmap_id TEXT NOT NULL,
        sprint_id TEXT NOT NULL,
        context TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        ticket_file TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      "CREATE INDEX tickets_project ON tickets (project_id, updated_at)",
      "CREATE INDEX tickets_sprint ON tickets (project_id, sprint_id, status)"
    ]
  },
  {
    version: 8,
    statements: [
      "CREATE TABLE IF NOT EXISTS agent_profiles (sequence INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL UNIQUE, profile_json TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS agent_profile_tombstones (agent_id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL)",
      "ALTER TABLE agent_profiles ADD COLUMN team TEXT"
    ]
  },
  {
    version: 9,
    statements: [
      `CREATE TABLE symbol_embeddings (
        symbol_id TEXT PRIMARY KEY,
        embedding_model TEXT NOT NULL,
        vector TEXT NOT NULL,
        content_checksum TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (symbol_id) REFERENCES symbols(symbol_id) ON DELETE CASCADE
      )`,
      "CREATE INDEX symbol_embeddings_model ON symbol_embeddings (embedding_model)"
    ]
  },
  {
    version: 10,
    statements: [
      `CREATE TABLE embedding_jobs (
        job_id TEXT PRIMARY KEY,
        symbol_id TEXT NOT NULL,
        content_checksum TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 100,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (symbol_id) REFERENCES symbols(symbol_id) ON DELETE CASCADE
      )`,
      "CREATE INDEX embedding_jobs_ready ON embedding_jobs (status, priority, next_retry_at, created_at)",
      "CREATE UNIQUE INDEX embedding_jobs_active_symbol ON embedding_jobs (symbol_id, model) WHERE status IN ('pending', 'processing', 'retry_wait')"
    ]
  }
];

// Applies unapplied schema versions atomically and records their completion.
export function runIndexMigrations(database) {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(database.prepare("SELECT version FROM schema_migrations").all().map(({ version }) => version));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    database.exec("BEGIN");
    try {
      for (const statement of migration.statements) database.exec(statement);
      database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
