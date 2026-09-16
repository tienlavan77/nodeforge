import process from "node:process";
import { resolve } from "node:path";

import { createTicketFileStore } from "../src/application/ticket-file-store.js";
import { createFileService } from "../src/infrastructure/filesystem/file-service.js";
import { openIndexDatabase } from "../src/infrastructure/sqlite/index-database.js";

const projectRoot = process.cwd();
const database = await openIndexDatabase(projectRoot, { runtimeDir: ".forge/runtime/nf" });
const fileService = createFileService({ projectRoot });
const tickets = createTicketFileStore({ database, fileService });

try {
  const currentRoadmaps = currentRoadmapsByProject(database);
  let migrated = 0;
  let skipped = 0;

  for (const roadmap of currentRoadmaps) {
    for (const ticket of (roadmap.sprints ?? []).flatMap((sprint) => sprint.tickets ?? [])) {
      if (tickets.getMetadata(ticket.id)) {
        skipped += 1;
        continue;
      }
      // Legacy roadmap records have no trustworthy original owner text.
      // Keep it empty rather than incorrectly treating English ticket fields
      // as the private Vietnamese context.
      tickets.create({ ticket, context: "" });
      migrated += 1;
    }
  }

  console.log(JSON.stringify({ project_root: resolve(projectRoot), roadmaps: currentRoadmaps.length, migrated, skipped }, null, 2));
} finally {
  await database.close();
}

function currentRoadmapsByProject(databaseService) {
  const current = new Map();
  for (const { roadmap_json } of databaseService.all("SELECT roadmap_json FROM governance_roadmaps ORDER BY sequence")) {
    const roadmap = JSON.parse(roadmap_json);
    current.set(roadmap.project_id, roadmap);
  }
  return [...current.values()];
}
