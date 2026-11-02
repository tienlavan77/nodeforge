// Exercises fresh and populated control databases, durable schema markers, 005_ideas_table legacy baselines, and atomic rollback.
// These storage tests intentionally keep Notebook outside the watcher schema.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runControlMigrations } from "../../src/infrastructure/sqlite/control-migrations.js";

/** Seeds the exact pre-Notebook 005_ideas_table (control-migrations.js#L1-L48) legacy schema and multi-project records. */
export function seedLegacy005IdeasTableBaseline(db, legacyVersion = 3, includeNamedBaselineMarker = true) {
  db.exec("CREATE TABLE control_schema_migrations (version INTEGER PRIMARY KEY)");
  if (includeNamedBaselineMarker) {
    db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO schema_migrations (version) VALUES ('005_ideas_table')").run();
  }
  db.exec(`CREATE TABLE ideas (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1)${legacyVersion >= 3 ? ", position INTEGER NOT NULL DEFAULT 0 CHECK (typeof(position) = 'integer' AND position >= 0)" : ""},
    PRIMARY KEY (project_id, id)
  )`);
  db.exec("CREATE INDEX ideas_by_project_status ON ideas (project_id, status, created_at, id)");
  db.prepare("INSERT INTO control_schema_migrations (version) VALUES (1)").run();

  if (legacyVersion >= 2) {
    db.exec(`CREATE TABLE idea_deletions (
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
      PRIMARY KEY (project_id, id)
    )`);
    db.prepare("INSERT INTO control_schema_migrations (version) VALUES (2)").run();
    db.exec(`INSERT INTO idea_deletions (project_id, id, version) VALUES
      ('project-alpha', 'del-alpha-1', 2),
      ('project-alpha', 'del-alpha-2', 5),
      ('project-beta', 'del-beta-1', 3)`);
  }

  if (legacyVersion >= 3) {
    db.exec("CREATE INDEX ideas_by_project_position ON ideas (project_id, position, created_at, id)");
    db.prepare("INSERT INTO control_schema_migrations (version) VALUES (3)").run();
    db.exec(`INSERT INTO ideas (id, project_id, content, status, created_at, updated_at, version, position) VALUES
      ('legacy-1', 'project-alpha', 'preserved alpha open', 'open', '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z', 1, 2),
      ('legacy-2', 'project-alpha', 'preserved alpha done', 'done', '2026-10-01T02:00:00.000Z', '2026-10-01T03:00:00.000Z', 4, 5),
      ('legacy-1', 'project-beta', 'preserved beta done', 'done', '2026-10-02T00:00:00.000Z', '2026-10-02T04:00:00.000Z', 7, 1)`);
  } else {
    db.exec(`INSERT INTO ideas (id, project_id, content, status, created_at, updated_at, version) VALUES
      ('legacy-1', 'project-alpha', 'preserved alpha open', 'open', '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z', 1),
      ('legacy-2', 'project-alpha', 'preserved alpha done', 'done', '2026-10-01T02:00:00.000Z', '2026-10-01T03:00:00.000Z', 4),
      ('legacy-1', 'project-beta', 'preserved beta done', 'done', '2026-10-02T00:00:00.000Z', '2026-10-02T04:00:00.000Z', 7)`);
  }
}

/** Asserts that all records, fields, project ownership, indexes, and deletion history survive migration and rerun. */
export function verifyLegacy005IdeasTableMigrationAndRerun() {
  for (const legacyVersion of [1, 2, 3]) {
    const db = new DatabaseSync(":memory:");
    try {
      seedLegacy005IdeasTableBaseline(db, legacyVersion, true);
      const expectedNotebooks = [
        {
          id: "legacy-1",
          project_id: "project-alpha",
          content: "preserved alpha open",
          status: "open",
          created_at: "2026-10-01T00:00:00.000Z",
          updated_at: "2026-10-01T01:00:00.000Z",
          version: 1,
          position: legacyVersion >= 3 ? 2 : 0
        },
        {
          id: "legacy-2",
          project_id: "project-alpha",
          content: "preserved alpha done",
          status: "done",
          created_at: "2026-10-01T02:00:00.000Z",
          updated_at: "2026-10-01T03:00:00.000Z",
          version: 4,
          position: legacyVersion >= 3 ? 5 : 0
        },
        {
          id: "legacy-1",
          project_id: "project-beta",
          content: "preserved beta done",
          status: "done",
          created_at: "2026-10-02T00:00:00.000Z",
          updated_at: "2026-10-02T04:00:00.000Z",
          version: 7,
          position: legacyVersion >= 3 ? 1 : 0
        }
      ];
      const expectedDeletions = legacyVersion >= 2
        ? [
            { project_id: "project-alpha", id: "del-alpha-1", version: 2 },
            { project_id: "project-alpha", id: "del-alpha-2", version: 5 },
            { project_id: "project-beta", id: "del-beta-1", version: 3 }
          ]
        : [];

      for (const pass of ["initial", "rerun"]) {
        runControlMigrations(db);
        assert.equal(db.prepare("SELECT MAX(version) AS version FROM control_schema_migrations").get().version, 4, `${pass}@v${legacyVersion}`);
        assert.deepEqual(
          db.prepare("SELECT version FROM control_schema_migrations ORDER BY version").all().map((r) => r.version),
          [1, 2, 3, 4]
        );
        assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ideas', 'idea_deletions')").all().length, 0);
        const rows = db.prepare("SELECT id, project_id, content, status, created_at, updated_at, version, position FROM notebooks ORDER BY project_id, id").all();
        assert.deepEqual(rows.map((r) => ({ ...r })), expectedNotebooks);
        const deletions = db.prepare("SELECT project_id, id, version FROM notebook_deletions ORDER BY project_id, id").all();
        assert.deepEqual(deletions.map((r) => ({ ...r })), expectedDeletions);
        const notebookIndexes = db.prepare("PRAGMA index_list(notebooks)").all().map((r) => r.name);
        assert.ok(notebookIndexes.includes("idx_notebooks_project_updated"));
        assert.ok(notebookIndexes.includes("idx_notebooks_project_position"));
        assert.ok(!notebookIndexes.includes("ideas_by_project_status"));
        assert.ok(!notebookIndexes.includes("ideas_by_project_position"));
        assert.ok(db.prepare("PRAGMA index_list(notebook_deletions)").all().some((r) => r.name === "idx_notebook_deletions_project_deleted"));
      }
    } finally {
      db.close();
    }
  }
}

/** Verifies fresh control database initialization, constraint checks, and idempotent reruns. */
export function verifyFreshAndIdempotentNotebookMigration() {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE existing (content TEXT); INSERT INTO existing VALUES ('keep')");
    runControlMigrations(db);
    db.exec("INSERT INTO notebooks (id, project_id, content, status, created_at, updated_at, version) VALUES ('one','project','saved','open','now','now',1)");
    runControlMigrations(db);
    assert.equal(db.prepare("SELECT content FROM existing").get().content, "keep");
    assert.equal(db.prepare("SELECT content FROM notebooks").get().content, "saved");
    assert.equal(db.prepare("SELECT position FROM notebooks").get().position, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM control_schema_migrations").get().n, 4);
    for (const [status, version, position] of [["invalid", 1, 0], ["open", 0, 0], ["open", 1.5, 0], ["open", 1, -1], ["open", 1, 1.5]]) {
      assert.throws(() => db.prepare("INSERT INTO notebooks (id, project_id, content, status, created_at, updated_at, version, position) VALUES ('bad','project','x',?,'now','now',?,?)").run(status, version, position));
    }
    assert.ok(db.prepare("PRAGMA index_list(notebooks)").all().some((row) => row.name === "idx_notebooks_project_updated"));
    assert.ok(db.prepare("PRAGMA index_list(notebooks)").all().some((row) => row.name === "idx_notebooks_project_position"));
    assert.ok(db.prepare("PRAGMA index_list(notebook_deletions)").all().some((row) => row.name === "idx_notebook_deletions_project_deleted"));
  } finally {
    db.close();
  }
}

/** Verifies atomic rollback on interrupted additive upgrades and fresh migration failures. */
export function verifyAdditiveRollbackAndRetry() {
  const db = new DatabaseSync(":memory:");
  try {
    runControlMigrations(db);
    // Cleanup to force recreations or handle partial states
    db.prepare("DROP TABLE IF EXISTS notebook_deletions").run();
    db.prepare("DELETE FROM control_schema_migrations WHERE version >= 2").run();
    
    // Start at version 1 with existing idea_deletions to induce failure during migration 2
    db.exec("INSERT INTO notebooks (id, project_id, content, status, created_at, updated_at, version) VALUES ('one','project','saved','open','now','now',3)");
    db.exec("CREATE TABLE idea_deletions (project_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (project_id, id))");
    
    assert.throws(() => runControlMigrations(db));
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM control_schema_migrations").get().version, 1);
    assert.equal(db.prepare("SELECT content FROM notebooks WHERE id = 'one'").get().content, "saved");
    
    // Cleanup and verify successful completion
    db.exec("DROP TABLE idea_deletions");
    runControlMigrations(db);
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM control_schema_migrations").get().version, 4);
    assert.equal(db.prepare("SELECT content FROM notebooks WHERE id = 'one'").get().content, "saved");
  } finally {
    db.close();
  }

  const freshDb = new DatabaseSync(":memory:");
  try {
    freshDb.exec("CREATE TABLE existing (value TEXT); CREATE INDEX ideas_by_project_status ON existing(value)");
    assert.throws(() => runControlMigrations(freshDb));
    assert.equal(freshDb.prepare("SELECT name FROM sqlite_master WHERE name IN ('notebooks','control_schema_migrations')").all().length, 0);
    freshDb.exec("DROP INDEX ideas_by_project_status");
    runControlMigrations(freshDb);
    assert.equal(freshDb.prepare("SELECT MAX(version) AS version FROM control_schema_migrations").get().version, 4);
  } finally {
    freshDb.close();
  }
}

test("Notebook migration preserves existing data and reruns without data loss", verifyFreshAndIdempotentNotebookMigration);
test("005_ideas_table legacy ideas and idea_deletions baseline migrates to notebooks and notebook_deletions and survives rerun", verifyLegacy005IdeasTableMigrationAndRerun);
test("deletion history, position migrations, and failed migrations roll back atomically and retry safely", verifyAdditiveRollbackAndRetry);
test("coexisting legacy ideas table and empty notebooks table merge cleanly without data loss", () => {
  const db = new DatabaseSync(":memory:");
  try {
    seedLegacy005IdeasTableBaseline(db, 3, true);
    db.exec(`CREATE TABLE notebooks (
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
    db.exec(`CREATE TABLE notebook_deletions (
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
      PRIMARY KEY (project_id, id)
    )`);
    runControlMigrations(db);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ideas', 'idea_deletions')").all().length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notebooks").get().count, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notebook_deletions").get().count, 3);
  } finally {
    db.close();
  }
});
