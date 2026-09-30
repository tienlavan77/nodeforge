// Serves persisted ticket evidence from a separate Control API process for restart tests.
import { createHttpApi } from "../../src/transport/http/server.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createCodeSearch } from "../../src/modules/index/code-search.js";
import { createFileGraph } from "../../src/modules/index/file-graph.js";
import { createTicketWorkspaceService } from "../../src/modules/supervisor/ticket-workspace-service.js";
import { createAgentProfileStore } from "../../src/modules/agent/agent-profile-store.js";
import { createAgentOccupancyStore } from "../../src/modules/agent/agent-occupancy-store.js";

const [projectRoot, projectId, taskId] = process.argv.slice(2);
const files = createFileService({ projectRoot });
const database = await openIndexDatabase(projectRoot);
const workspaces = createTicketWorkspaceService({ projectRoot, projectId, stateFileService: files, protocolStorage: { get() {}, save() {} }, indexDatabase: database, codeSearch: createCodeSearch({ database }), fileGraph: createFileGraph({ database }) });
const occupancy = createAgentOccupancyStore({ database, profiles: createAgentProfileStore({ database }) });
const api = createHttpApi({ forgeV1Router: { route: async (method, url) => {
  if (method !== "GET" || url.pathname !== `/forge/v1/tickets/${taskId}/evidence`) return null;
  const workspace = await workspaces.open(taskId);
  const context = await workspace.executionContexts.load(taskId);
  const artifact = await workspace.testService.assertPassedArtifact();
  return { status: 200, body: { task_id: taskId, context_state: context.state, context_revision: context.version, artifact_id: artifact.artifact_id, commit_sha: artifact.commit_sha, active_claim: occupancy.getByTask(taskId)?.claim_id ?? null } };
} } });
const server = api.createServer();
server.listen(0, "127.0.0.1", () => process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`));

// Closes only this test-owned process and its SQLite handles.
async function shutdown() { await new Promise((resolve) => server.close(resolve)); await workspaces.close(); await database.close(); process.exit(0); }
process.once("SIGTERM", () => { void shutdown().catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); }); });
