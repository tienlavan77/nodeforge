// Creates and revises Sprint scope in Registry instead of mutating the obsolete Roadmap projection.
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { sprintPlanDraftContent } from "../modules/governance/sprint-plan-draft.js";
import { backfillTicketCandidates } from "../modules/index/ticket-scope.js";
import { assertTicketVerificationContract } from "../modules/governance/ticket-verification-contract.js";

const require = createRequire(import.meta.url);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(require("../../../schemas/core/common.schema.json"));
ajv.addSchema(require("../../../schemas/governance/ticket.schema.json"));
const validate = ajv.compile(require("../../../schemas/governance/sprint-plan.schema.json"));

// Produces scoped CRUD failures without silently falling back to legacy writes.
function fail(code, message, statusCode = 409) { return Object.assign(new Error(message), { code, message, statusCode, retryable: false, scope: "scoped" }); }

// Binds each mutation to this runtime's project and exact observed scheduling version.
export function createRegistrySprintCrudService({ projectId, registry, plans }) {
  return Object.freeze({ create, update, remove });

  // Validates canonical ticket scope and requires review sections rather than inventing human approval content.
  function content(input, sprintId) {
    if (!input || input.project_id !== projectId || input.id !== sprintId) throw fail("PROJECT_CONTEXT_CONFLICT", "Sprint identity differs from the requested project or Sprint.");
    const sprint = { ...input, tickets: (input.tickets ?? []).map(backfillTicketCandidates) };
    if (!validate(sprint)) throw fail("SPRINT_PLAN_INVALID", "Sprint payload does not conform to the canonical Sprint schema.", 400);
    if (sprint.tickets.some((ticket) => ticket.project_id !== projectId || ticket.sprint_id !== sprintId) || new Set(sprint.tickets.map((ticket) => ticket.id)).size !== sprint.tickets.length) throw fail("TICKET_PLAN_SCOPE", "Ticket identities must be unique and belong to this project Sprint.");
    for (const ticket of sprint.tickets) assertTicketVerificationContract(ticket);
    return sprintPlanDraftContent(sprint);
  }

  // Creates a reviewable first revision and schedules it without approval or RUN authority.
  async function create({ sprintPlan, position } = {}) {
    const draftContent = content(sprintPlan, sprintPlan?.id);
    const id = sprintPlan.id;
    if (registry.get(id, { includeArchived: true })) throw fail("SPRINT_REGISTRY_EXISTS", "Sprint identity is already registered or archived.");
    const planId = `PLAN-${id}`;
    if (plans.list().some((head) => head.plan_id === planId)) throw fail("SPRINT_RECONCILIATION_REQUIRED", "An existing plan must be reconciled before creating this Sprint.");
    const records = registry.list({ includeArchived: true });
    const nextPosition = position ?? (records.length ? Math.max(...records.map((record) => record.position)) + 1 : 0);
    if (!Number.isSafeInteger(nextPosition) || nextPosition < 0 || records.some((record) => record.position === nextPosition)) throw fail("SPRINT_REGISTRY_INPUT", "Sprint position is invalid or occupied.");
    for (const dependency of sprintPlan.dependencies ?? []) {
      const record = registry.get(dependency);
      if (!record || record.position >= nextPosition) throw fail("SPRINT_DEPENDENCY_INVALID", "Dependencies must be active earlier Sprints.");
    }
    const revision = await plans.createRevision({ planId, sprintId: id, expectedRevision: 0, content: draftContent });
    try { await registry.register({ sprintId: id, position: nextPosition, dependencies: sprintPlan.dependencies ?? [], planId, revision: revision.revision }); }
    catch (error) { error.recovery = { plan_id: planId, revision: revision.revision, sha256: revision.sha256, disposition: "retained_immutable_revision" }; throw error; }
    return { sprint_id: id, sprint_plan: await registry.getDetail(id), plan: revision };
  }

  // Replans from exact scheduling expectations; prior decisions remain bound only to the old immutable revision.
  async function update({ sprintId, sprintPlan, expectedVersion } = {}) {
    if (!Number.isSafeInteger(expectedVersion)) throw fail("SPRINT_REGISTRY_CONFLICT", "Update requires expected_version from the current Sprint detail.");
    const current = registry.assertMutable(sprintId, expectedVersion);
    const draftContent = content(sprintPlan, sprintId);
    if (JSON.stringify(sprintPlan.dependencies ?? []) !== JSON.stringify(current.dependencies)) throw fail("SPRINT_DEPENDENCY_CONFLICT", "This scope update cannot silently change Sprint scheduling dependencies.");
    const planId = current.plan_id ?? `PLAN-${sprintId}`;
    const head = plans.list().find((item) => item.plan_id === planId);
    const revision = await plans.createRevision({ planId, sprintId, expectedRevision: head?.revision ?? 0, content: draftContent });
    try { await registry.bindPlan({ sprintId, planId, revision: revision.revision, expectedVersion }); }
    catch (error) { error.recovery = { plan_id: planId, revision: revision.revision, sha256: revision.sha256, disposition: "retained_immutable_revision" }; throw error; }
    return { sprint_id: sprintId, sprint_plan: await registry.getDetail(sprintId), plan: revision };
  }

  // Archives scheduling visibility while retaining immutable scope, decisions and execution history.
  function remove({ sprintId, expectedVersion }) {
    if (!Number.isSafeInteger(expectedVersion)) throw fail("SPRINT_REGISTRY_CONFLICT", "Delete requires expected_version from the current Sprint detail.");
    return registry.archive({ sprintId, expectedVersion });
  }
}
