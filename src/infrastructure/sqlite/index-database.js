import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ConfigurationError } from "../../shared/errors.js";

const DATABASE_FILE = "index.db";
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
  }
];

export async function ensureRuntimeDir(projectRoot) {
  assertProjectRoot(projectRoot);
  const runtimeDir = join(projectRoot, ".forge", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  return runtimeDir;
}

export async function openIndexDatabase(projectRoot, { busyTimeoutMs = 10000, journalMode = "WAL" } = {}) {
  const runtimeDir = await ensureRuntimeDir(projectRoot);
  const databasePath = join(runtimeDir, DATABASE_FILE);
  const database = new DatabaseSync(databasePath);
  let closed = false;

  database.exec("PRAGMA foreign_keys = ON");
  // Multiple Node processes (API + project watcher) share this runtime DB.
  // WAL plus a busy timeout lets short writes queue instead of crashing streams.
  database.exec(`PRAGMA journal_mode = ${journalMode}`);
  database.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`);
  runMigrations(database);

  return Object.freeze({
    databasePath,
    all(sql, parameters = []) {
      if (closed) throw new ConfigurationError("Cannot query a closed index database.");
      const statement = database.prepare(sql);
      return statement.all(...parameters).map((row) => ({ ...row }));
    },
    run(sql, parameters = []) {
      if (closed) throw new ConfigurationError("Cannot write to a closed index database.");
      return database.prepare(sql).run(...parameters);
    },
    transaction(callback) {
      if (closed) throw new ConfigurationError("Cannot transact on a closed index database.");
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = callback();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    async close() {
      if (closed) return;
      database.close();
      closed = true;
    }
  });
}

function assertProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new ConfigurationError("A project root is required for the index database.");
  }
}

function runMigrations(database) {
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
