// Rebinds parked review repairs to proven replacement dependency completions without replacing the ticket execution.
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { isDeepStrictEqual } from "node:util";
import { matchesTicketExecution } from "./ticket-execution-identity.js";

// Creates an explicit transactional repair boundary while ordinary RUN and provider launch retain exact dependency fences.
export function createReviewDependencyStatus({ database, get, transition, emit }) {
  return function reconcileReviewDependencies(ticketId, { executionId, basis, expectedVersion, previous, dependencies, receipt, validate } = {}) {
    if (typeof validate !== "function" || typeof database.transaction !== "function") throw conflict("Review dependency reconciliation requires transactional validation.");
    return database.transaction(() => {
      const current = get(ticketId);
      if (!current || current.version !== expectedVersion || !["reviewing", "failed", "pending"].includes(current.status)
        || !current.details.review_reopen?.job_id || !current.details.review_reopen.owner_request || current.details.launch_claim
        || !matchesTicketExecution(current, executionId, basis) || !isDeepStrictEqual(current.details.dependency_expectations, previous)
        || !Array.isArray(previous) || !Array.isArray(dependencies) || previous.length !== dependencies.length
        || !receipt?.path?.startsWith(statePath("review-dependency-reconciliation/")) || !/^sha256:[a-f0-9]{64}$/.test(receipt.sha256 ?? "")) throw conflict("Review repair no longer owns the parked dependency boundary.");
      for (const before of previous) {
        const after = dependencies.find((entry) => entry.ticket_id === before.ticket_id);
        if (!after || !isDeepStrictEqual({ ...before, execution_id: after.execution_id }, after)) throw conflict("A repair cannot change dependency scope or its immutable plan.");
      }
      const checked = validate();
      if (checked?.then) throw conflict("Dependency validation must be synchronous inside the status transaction.");
      const updated = transition(ticketId, current, current.status, { ...current.details, dependency_expectations: structuredClone(dependencies),
        review_dependency_reconciliation: structuredClone(receipt), reason: "review_dependencies_reconciled" });
      emit("ticket.status_change", { project_id: current.project_id, ticket_id: ticketId, from: current.status, to: updated.status, version: updated.version,
        reason: updated.details.reason, details: updated.details, timestamp: updated.updated_at });
      return updated;
    });
  };
}

// Leaves changed plans and active executions untouched for normal reconciliation.
function conflict(message) { return Object.assign(new Error(message), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED", statusCode: 409 }); }
