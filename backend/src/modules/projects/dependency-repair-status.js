// Reopens an approved upstream ticket for a Sprint-coordinated repair while retaining its execution identity.
// This is distinct from Owner-requested review and never manufactures a Reviewer finding or Owner receipt.
import { isDeepStrictEqual } from "node:util";
import { matchesTicketExecution } from "./ticket-execution-identity.js";

// Makes repair preparation transactional so an old dependency request cannot replace a concurrent launch.
export function createDependencyRepairStatus({ database, get, transition, emit }) {
  return function prepareDependencyRepair(ticketId, { expectedVersion, executionId, basis, binding, validate } = {}) {
    return database.transaction(() => {
      const current = get(ticketId);
      if (!current || current.version !== expectedVersion || !["done", "pending", "failed"].includes(current.status)
        || current.details.launch_claim || current.details.reason === "TICKET_STOPPED" || !matchesTicketExecution(current, executionId, basis) || typeof validate !== "function"
        || !["preparing", "ready"].includes(binding?.state) || !binding?.id || !binding.parent_ticket_id || !binding.parent_execution_id || !binding.receipt) {
        throw Object.assign(new Error("Dependency repair no longer owns its approved parked execution."), { code: "DEPENDENCY_REPAIR_CONFLICT" });
      }
      if (validate()?.then) throw Object.assign(new Error("Dependency validation must be synchronous."), { code: "DEPENDENCY_REPAIR_CONFLICT" });
      if (isDeepStrictEqual(current.details.dependency_repair, binding)) return current;
      const updated = transition(ticketId, current, "pending", { ...current.details, reason: "dependency_repair_pending", error: null,
        review_reopen: null, dependency_repair: structuredClone(binding) });
      if (current.status !== "pending") emit?.("ticket.status_change", { project_id: current.project_id, ticket_id: ticketId,
        from: current.status, to: "pending", version: updated.version, reason: updated.details.reason, details: updated.details, timestamp: updated.updated_at });
      return updated;
    });
  };
}
