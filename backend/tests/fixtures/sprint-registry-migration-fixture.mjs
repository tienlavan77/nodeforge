// Creates real SQLite, legacy Sprint and immutable-plan storage for maintenance migration witnesses.
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createRoadmapStore } from "../../src/modules/governance/roadmap-store.js";
import { createSprintPlanUploadService } from "../../src/application/sprint-plan-upload-service.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketFileStore } from "../../src/application/ticket-file-store.js";

export const PROJECT = "PROJECT-NODEFORGE";
export const REVIEW = { outcome: "Show legacy scope", in_scope: "Dashboard", out_of_scope: "Execution", approach: "Preserve scope", components: ["Dashboard"], risks: [], assumptions: [], open_questions: [], evidence_refs: ["TICKET-MIGRATION"], acceptance_criteria: ["Show tickets without granting RUN"] };
export const SPRINT = {
  id: "SPRINT-MIGRATION", roadmap_id: "ROADMAP-MIGRATION", project_id: PROJECT, objective: "Preserve legacy Sprint", human_plan: REVIEW,
  tickets: [{ id: "TICKET-MIGRATION", project_id: PROJECT, roadmap_id: "ROADMAP-MIGRATION", sprint_id: "SPRINT-MIGRATION", title: "Preserve ticket", objective: "Preserve ticket", acceptance_criteria: ["Visible scope"], verification_plan: [{ criterion_ids: ["AC-1"], kind: "test", test_path: "backend/tests/integration/sprint-registry-migration.test.js" }], priority: "high", provenance: { source: "sprint_plan", source_id: "SPRINT-MIGRATION", created_at: "2026-10-09T00:00:00Z" } }],
  exit_criteria: ["Visible dashboard"]
};

// Seeds canonical legacy data without registering Sprints or creating approval decisions.
export async function sprintMigrationFixture({ includeReview = true } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "sprint-registry-migration-"));
  const dataDir = join(cwd, ".forge/runtime/nf");
  const database = await createDatabaseService({ dataDir, runtimeDir: "." });
  database.run("CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, event_type TEXT NOT NULL, timestamp TEXT NOT NULL, source TEXT NOT NULL, event_json TEXT NOT NULL, project_id TEXT NOT NULL)");
  const files = createFileService({ projectRoot: cwd });
  const roadmaps = createRoadmapStore({ database });
  const upload = createSprintPlanUploadService({ roadmaps, projectRoot: cwd });
  const sprint = structuredClone(SPRINT);
  if (!includeReview) delete sprint.human_plan;
  upload.upload({ projectId: PROJECT, sprintPlan: sprint });
  const statuses = createTicketStatusStore({ projectId: PROJECT, database });
  const tickets = createTicketFileStore({ database, fileService: files });
  tickets.create({ ticket: roadmaps.getCurrent().sprints[0].tickets[0], context: "Private owner context" });
  const config = { cwd, dataDir, projectId: PROJECT };
  return { config, database, roadmaps, upload, statuses, tickets, files, close: async () => { await database.close(); await rm(cwd, { recursive: true, force: true }); } };
}
