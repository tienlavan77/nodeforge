export function migrateTaskTeam(database) {
  const columns = database.all("PRAGMA table_info(project_tasks)");
  if (!columns.some((column) => column.name === "team")) {
    database.run("ALTER TABLE project_tasks ADD COLUMN team TEXT NOT NULL DEFAULT 'unassigned'");
  }
  database.run("CREATE INDEX IF NOT EXISTS project_tasks_by_team ON project_tasks (project_id, team)");
}
