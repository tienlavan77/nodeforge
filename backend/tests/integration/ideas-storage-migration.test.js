// Exercises fresh and populated control databases, durable schema markers and atomic rollback.
// These storage tests intentionally keep Ideas outside the watcher schema.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runControlMigrations } from "../../src/infrastructure/sqlite/control-migrations.js";

test("Ideas migration preserves existing data and reruns without data loss", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE existing (content TEXT); INSERT INTO existing VALUES ('keep')");
    runControlMigrations(db);
    db.exec("INSERT INTO ideas VALUES ('one','project','saved','open','now','now',1)");
    runControlMigrations(db);
    assert.equal(db.prepare("SELECT content FROM existing").get().content, "keep");
    assert.equal(db.prepare("SELECT content FROM ideas").get().content, "saved");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM control_schema_migrations").get().n, 2);
    for (const [status, version] of [["invalid", 1], ["open", 0], ["open", 1.5]]) {
      assert.throws(() => db.prepare("INSERT INTO ideas VALUES ('bad','project','x',?,'now','now',?)").run(status, version));
    }
    assert.ok(db.prepare("PRAGMA index_list(ideas)").all().some(row => row.name === "ideas_by_project_status"));
  } finally { db.close(); }
});

// Simulates a populated revision-one installation and an interrupted additive upgrade.
// Both existing notebook content and the revision marker must survive a failed attempt.
test("deletion history migration upgrades revision one atomically and reruns safely", () => {
  const db = new DatabaseSync(":memory:");
  try {
    runControlMigrations(db);
    db.exec("DROP TABLE idea_deletions; DELETE FROM control_schema_migrations WHERE version = 2");
    db.exec("INSERT INTO ideas VALUES ('one','project','saved','open','now','now',3)");
    db.exec("CREATE TABLE idea_deletions (blocked TEXT)");
    assert.throws(() => runControlMigrations(db));
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM control_schema_migrations").get().version, 1);
    assert.equal(db.prepare("SELECT content FROM ideas").get().content, "saved");
    db.exec("DROP TABLE idea_deletions");
    runControlMigrations(db);
    db.exec("INSERT INTO idea_deletions VALUES ('project','deleted',2)");
    runControlMigrations(db);
    assert.equal(db.prepare("SELECT version FROM idea_deletions").get().version, 2);
    assert.equal(db.prepare("SELECT version FROM ideas").get().version, 3);
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM control_schema_migrations").get().version, 2);
  } finally { db.close(); }
});

test("failed Ideas migration rolls back schema and marker and permits retry", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE existing (value TEXT); CREATE INDEX ideas_by_project_status ON existing(value)");
    assert.throws(() => runControlMigrations(db));
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('ideas','control_schema_migrations')").all().length, 0);
    db.exec("DROP INDEX ideas_by_project_status");
    runControlMigrations(db);
    assert.equal(db.prepare("SELECT version FROM control_schema_migrations").get().version, 1);
  } finally { db.close(); }
});
