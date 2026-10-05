// Validates criterion-to-check mappings so Forge can verify ticket completion deterministically.
import { ConfigurationError } from "../../shared/errors.js";

const KINDS = new Set(["test", "backend_tests", "build", "lint", "typecheck", "schema_validation", "browser", "governance", "human"]);

// Rejects plans that omit a criterion or describe checks Forge cannot identify.
export function assertTicketVerificationContract(ticket) {
  const criteria = Array.isArray(ticket?.acceptance_criteria) ? ticket.acceptance_criteria : [];
  const plan = ticket?.verification_plan;
  if (!criteria.length || !Array.isArray(plan) || !plan.length) throw failure("Ticket requires a verification_plan covering every acceptance criterion.");
  const expected = new Set(criteria.map((_, index) => `AC-${index + 1}`));
  const seen = new Set();
  for (const step of plan) {
    if (!step || !KINDS.has(step.kind) || !Array.isArray(step.criterion_ids) || !step.criterion_ids.length) throw failure("Each verification step requires a supported kind and criterion_ids.");
    if (step.kind === "test" && !nonBlank(step.test_path)) throw failure("A test verification step requires test_path.");
    if (step.kind === "browser" && (!Array.isArray(step.assertions) || !step.assertions.length || !Array.isArray(step.viewports) || !step.viewports.length)) throw failure("A browser verification step requires assertions and viewports.");
    for (const id of step.criterion_ids) {
      if (!expected.has(id)) throw failure(`Verification plan references unknown criterion ${id}.`);
      seen.add(id);
    }
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) throw failure(`Verification plan does not cover ${missing.join(", ")}.`);
  return true;
}

function nonBlank(value) { return typeof value === "string" && value.trim().length > 0; }
function failure(message) { return Object.assign(new ConfigurationError(message), { code: "TICKET_VERIFICATION_PLAN_INVALID", statusCode: 422 }); }
