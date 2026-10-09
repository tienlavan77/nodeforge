// Competes for one persisted Ticket launch owner in a separate process without invoking a provider or RUN.
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";

const database = await createDatabaseService({ dataDir: process.argv[2], runtimeDir: "." });
try {
  const store = createTicketStatusStore({ database, projectId: "PROJECT-A" });
  const current = store.get("TICKET-A");
  try {
    const receipt = store.claimExecutionLaunch("TICKET-A", { executionId: "RUN-A", basis: current.details.execution_basis,
      requestId: `REQ-${process.pid}`, jobId: `JOB-${process.pid}`, supervisorId: `SUP-${process.pid}`, agentId: `CODER-${process.pid}`,
      validate: () => { if (store.get("TICKET-A").details.dependency_expectations.length !== 0) throw new Error("Unexpected dependency intent"); } });
    process.stdout.write(`${JSON.stringify({ claimed: true, receipt })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ claimed: false, code: error.code, message: error.message })}\n`);
  }
} finally { await database.close(); }
