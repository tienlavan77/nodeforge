// Exercises automatic blocker recovery through actual SDK ticket integration and locked file/checkpoint stores.
import { createHash } from "node:crypto";
import { coderProductionRecoveryFixture, TICKET } from "./coder-production-recovery-fixture.js";
import { createProductionBlockerRecovery } from "../../src/modules/supervisor/blocker-recovery-runtime.js";

// Creates a source-bound blocked ticket whose second Coder invocation can complete without an owner reset.
export async function blockerRecoveryFixture({ reason = "SCOPE_CONFLICT", investigate, ticket: overrides = {}, repeatBlock = false, limits, recoveryOptions = {} } = {}) {
  const ticket = { ...TICKET, objective: "Reuse backend/src/handler.js under the existing approved contract.", ...overrides };
  const source = "export const approvedHandler = true;\n";
  const evidence = { path: "backend/src/handler.js", sha256: createHash("sha256").update(source).digest("hex") };
  const calls = [];
  let now = 1000;
  const base = await coderProductionRecoveryFixture({ ticket, behavior: async ({ onEvent }, invocation) => {
    if (invocation === 1 || repeatBlock) {
      const details = { blocker: { reason_code: reason }, evidence: ["backend/src/handler.js:1"] };
      await onEvent({ type: "item.completed", item: { id: "blocked", type: "mcp_tool_call", server: "forge", tool: "report_done", status: "failed",
        result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error_code: "CODER_BLOCKED", message: "Investigate existing approved behavior", details }) }] } } });
      return { text: "Blocked" };
    }
    for (const tool of ["write_diff", "commit_changes", "report_done"]) await onEvent({ type: "item.completed", item: { id: tool, type: "mcp_tool_call", server: "forge", tool, status: "completed" } });
    return { text: "Reported" };
  } });
  await base.fileService.atomicWrite({ path: evidence.path, content: source, replace: true });
  const resolution = { action: "resolved", summary: "Existing approved behavior verified.", guidance: "Continue the approved handler implementation; do not invent a new contract.", authority_quote: ticket.objective, evidence: [evidence] };
  let recovery;
  // Reconstructs only the recovery worker while retaining the same durable execution and source stores.
  function recreate(options = {}) {
    recovery?.stop();
    recovery = createProductionBlockerRecovery({ store: base.store, fileService: base.fileService,
      ticketStatusStore: base.statusStore, sprintRegistry: base.registry, resolveTicketWorkspace: async () => base.workspace,
      checkpoints: base.checkpoints, eventBus: base.eventBus, agentOccupancy: base.occupancy,
      submitTicket: (input) => base.service.runTicket(input), disposition: { get: async () => null },
      clock: () => now, logger: { warn() {}, error() {} }, limits: { deadlineMs: 600_000, ...(limits ?? {}) },
      investigate: async (job) => { calls.push(job.stage); return investigate ? investigate(job, resolution)
        : job.stage === "sprint_leader" && !job.architecture_response ? { action: "architecture_required", summary: "This blocker requires Architecture verification." } : resolution; }, ...recoveryOptions, ...options });
    base.restart({ blockerRecovery: recovery });
    return recovery;
  }
  recreate();
  return { base, ticket, evidence, calls, resolution, recreate,
    get recovery() { return recovery; },
    advance: (delta) => { now += delta; base.advance(delta); },
    ledger: async () => (await base.store.list("blocker.recovery"))[0],
    close: async () => { recovery.stop(); await base.close(); } };
}
