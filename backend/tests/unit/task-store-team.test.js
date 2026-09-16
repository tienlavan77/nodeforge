import assert from "node:assert/strict";
import test from "node:test";

import { createTaskStore } from "../../src/modules/projects/task-store.js";

function database() {
  const rows = new Map();
  const calls = [];
  return {
    calls,
    run(sql, params = []) {
      calls.push(sql);
      if (sql.startsWith("INSERT INTO project_tasks")) rows.set(params[0], { task_json: params[3] });
      if (sql.startsWith("UPDATE project_tasks")) rows.set(params[2], { task_json: params[1] });
    },
    all(sql, params = []) {
      if (sql.startsWith("PRAGMA table_info")) return [{ name: "task_id" }, { name: "project_id" }, { name: "team" }, { name: "task_json" }];
      if (sql.includes("SELECT task_json")) return rows.has(params[0]) ? [rows.get(params[0])] : [];
      return [];
    }
  };
}

const task = { type: "feature", title: "Team task", status: "active", created_at: "2026-09-16T00:00:00Z" };

test("task store creates, reads, and updates team", () => {
  const db = database();
  const store = createTaskStore({ database: db, projectId: "PROJECT-1", createId: () => "TASK-1" });

  const created = store.create({ ...task, team: "platform" });
  assert.equal(created.team, "platform");
  assert.equal(store.get("TASK-1").team, "platform");

  const updated = store.update("TASK-1", { team: "security" });
  assert.equal(updated.team, "security");
  assert.equal(store.get("TASK-1").team, "security");
  assert.ok(db.calls.some((sql) => sql.includes("team TEXT NOT NULL")));
  assert.ok(db.calls.some((sql) => sql.includes("project_tasks_by_team")));
});
