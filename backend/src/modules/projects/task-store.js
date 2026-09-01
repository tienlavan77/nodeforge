import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../../schemas/core/common.schema.json");
const taskSchema = require("../../../../schemas/project/task.schema.json");

export function createTaskId() {
  return `TASK-${randomUUID()}`;
}

export function createTaskStore({ database, projectId, createId = createTaskId } = {}) {
  if (!database?.run || !database?.all) throw new ConfigurationError("A SQLite database is required for task persistence.");
  if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("A project_id is required for task persistence.");
  if (typeof createId !== "function") throw new ConfigurationError("Task ID creation must be a function.");
  ensureTaskTable(database);

  function get(taskId) {
    const row = database.all("SELECT task_json FROM project_tasks WHERE task_id = ? AND project_id = ?", [taskId, projectId])[0];
    if (!row) return undefined;
    const task = JSON.parse(row.task_json);
    validateTask(task);
    return Object.freeze(task);
  }

  return Object.freeze({
    create({ id = createId(), ...attributes } = {}) {
      const task = { id, project_id: projectId, ...attributes };
      validateTask(task);
      database.run("INSERT INTO project_tasks (task_id, project_id, task_json) VALUES (?, ?, ?)", [task.id, projectId, JSON.stringify(task)]);
      return Object.freeze({ ...task });
    },
    get
  });
}

function ensureTaskTable(database) {
  database.run(`CREATE TABLE IF NOT EXISTS project_tasks (
    task_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_json TEXT NOT NULL
  )`);
  database.run("CREATE INDEX IF NOT EXISTS project_tasks_by_project ON project_tasks (project_id)");
}

function validateTask(task) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(taskSchema);
  const validate = ajv.getSchema(taskSchema.$id);
  if (!validate(task)) {
    throw new ConfigurationError(`Invalid task record: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  }
}
