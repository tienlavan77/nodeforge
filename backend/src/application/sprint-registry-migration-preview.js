// Builds a source-bound migration preview without granting approval or changing legacy Sprint data.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { sprintPlanDraftContent } from "../modules/governance/sprint-plan-draft.js";
import { backfillTicketCandidates } from "../modules/index/ticket-scope.js";

const require = createRequire(import.meta.url);
const validator = new Ajv2020({ allErrors: true, strict: false });
addFormats(validator);
validator.addSchema(require("../../../schemas/core/common.schema.json"));
validator.addSchema(require("../../../schemas/governance/ticket.schema.json"));
const validateSprint = validator.compile(require("../../../schemas/governance/sprint-plan.schema.json"));
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IMPLEMENTATION_TYPES = new Set(["frontend", "backend", "security"]);

// Hashes canonical JSON so manifest identities survive key ordering and operator round trips.
export function migrationHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

// Orders object keys while retaining the business ordering of Sprint and Ticket arrays.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  return value;
}

// Mirrors the Plan Store's exclusion of retrieval candidates from immutable approval scope.
function approvalContent(value) {
  if (Array.isArray(value)) return value.map(approvalContent);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["candidate_files", "candidates_produced_by", "candidates_produced_at"].includes(key)).map(([key, entry]) => [key, approvalContent(entry)]));
}

// Compares executable ticket identity and acceptance scope while ignoring retrieval and live workflow metadata.
function ticketMigrationContent(value) {
  const content = approvalContent(value);
  const stripWorkflow = (entry) => {
    if (Array.isArray(entry)) return entry.map(stripWorkflow);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(Object.entries(entry).filter(([key]) => !["status", "last_error"].includes(key)).map(([key, nested]) => [key, stripWorkflow(nested)]));
  };
  return stripWorkflow(content);
}

// Normalizes historical metadata into the current immutable ticket schema without guessing unsupported legacy categories.
function normalizeLegacySprint(original, blockers, ticketTypeOverrides, normalizations) {
  const sprint = { ...original };
  delete sprint.sequence;
  sprint.tickets = (sprint.tickets ?? []).map((ticket) => {
    const normalized = structuredClone(ticket);
    const override = ticketTypeOverrides[ticket.id];
    const overrideType = Array.isArray(override) ? override : override?.implementation_type;
    if (normalized.implementation_type === undefined && Array.isArray(normalized.style)) {
      if (normalized.style.length === 1 && IMPLEMENTATION_TYPES.has(normalized.style[0])) normalized.implementation_type = [...normalized.style];
      else if (Array.isArray(overrideType) && overrideType.length === 1 && IMPLEMENTATION_TYPES.has(overrideType[0]) && typeof override?.rationale === "string" && override.rationale.trim()) {
        normalized.implementation_type = [...overrideType];
        normalizations.push({ ticket_id: normalized.id, source_style: [...normalized.style], implementation_type: [...overrideType], rationale: override.rationale });
      } else blockers.push({ code: "SPRINT_MIGRATION_IMPLEMENTATION_TYPE_INVALID", identifier: SAFE_ID.test(normalized.id ?? "") ? normalized.id : "invalid-identifier" });
    }
    delete normalized.style;
    return normalized;
  });
  return sprint;
}

// Reports migration conflicts without converting missing business scope into invented approval content.
export function migrationError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409, retryable: false, scope: "scoped" });
}

// Plans additive imports; explicit human-plan supplements may fill review sections but never replace Ticket specs.
export function buildSprintMigrationPreview({ projectId, source, registryRecords, supplements = {} }) {
  const blockers = [];
  const entries = [];
  const normalizations = [];
  const excludedTickets = [];
  const sourceSprints = new Map((source.historical_sprints ?? []).filter((sprint) => sprint.project_id === projectId).map((sprint) => [sprint.id, sprint]));
  if (source.roadmap?.project_id === projectId) for (const sprint of source.roadmap.sprints ?? []) sourceSprints.set(sprint.id, sprint);
  const neededIds = new Set([...(source.roadmap?.project_id === projectId ? (source.roadmap.sprints ?? []).map((sprint) => sprint.id) : []), ...(source.metadata ?? []).filter((entry) => entry.project_id === projectId).map((entry) => entry.sprint_id)]);
  const scoped = [...neededIds].map((id) => sourceSprints.get(id)).filter(Boolean);
  const registered = new Map(registryRecords.map((record) => [record.sprint_id, record]));
  const positions = registryRecords.map((record) => record.position);
  let position = positions.length ? Math.max(...positions) + 1 : 0;
  const seen = new Set();
  const ticketOwners = new Map();
  const known = new Set(registered.keys());
  // Adds bounded identifiers to operator diagnostics without swallowing validation failures.
  function block(code, id) { blockers.push({ code, identifier: SAFE_ID.test(id ?? "") ? id : "invalid-identifier" }); }
  for (const original of scoped) {
    if (!SAFE_ID.test(original.id ?? "") || seen.has(original.id)) { block("SPRINT_MIGRATION_ID_CONFLICT", original.id); continue; }
    seen.add(original.id);
    const supplement = supplements[original.id];
    const humanPlan = supplement?.human_plan ?? supplement;
    const ticketTypeOverrides = supplement?.ticket_implementation_types ?? {};
    const ticketIds = new Set((original.tickets ?? []).map((ticket) => ticket.id));
    for (const ticketId of Object.keys(ticketTypeOverrides)) if (!ticketIds.has(ticketId)) block("SPRINT_MIGRATION_TICKET_OVERRIDE_UNKNOWN", ticketId);
    const normalized = normalizeLegacySprint(original, blockers, ticketTypeOverrides, normalizations);
    const tickets = (normalized.tickets ?? []).map((ticket) => backfillTicketCandidates(structuredClone(ticket)));
    for (const ticket of tickets) {
      if (!SAFE_ID.test(ticket.id ?? "") || ticket.project_id !== projectId || ticket.sprint_id !== original.id || ticketOwners.has(ticket.id)) block("SPRINT_MIGRATION_TICKET_OWNERSHIP", ticket.id);
      ticketOwners.set(ticket.id, original.id);
    }
    if (registered.has(original.id)) { known.add(original.id); continue; }
    const sprint = { ...normalized, tickets, human_plan: humanPlan ?? normalized.human_plan };
    if (original.project_id !== projectId || !validateSprint(sprint)) { block("SPRINT_MIGRATION_SCOPE_INCOMPLETE", original.id); continue; }
    let content;
    try { content = approvalContent(sprintPlanDraftContent(sprint)); }
    catch (error) { block(error.code === "PLAN_DRAFT_INCOMPLETE" ? "SPRINT_MIGRATION_SCOPE_INCOMPLETE" : error.code ?? "SPRINT_MIGRATION_SCOPE_INCOMPLETE", original.id); continue; }
    const dependencies = sprint.dependencies ?? [];
    if (dependencies.some((id) => !known.has(id))) { block("SPRINT_MIGRATION_DEPENDENCY_ORDER", original.id); continue; }
    const contentHash = migrationHash({ projectId, sprintId: sprint.id, content });
    entries.push({ sprint_id: sprint.id, plan_id: `MIG-${contentHash.slice(0, 40)}`, position: position++, dependencies, content, content_sha256: contentHash });
    known.add(sprint.id);
  }
  const scopeDrift = new Map();
  const deletedTickets = new Map((source.ticket_deletions ?? []).filter((entry) => entry.project_id === projectId && entry.source === "sprint-plan-service" && entry.event_type === "ticket.deleted" && entry.ticket_id && entry.sprint_id).map((entry) => [`${entry.sprint_id}:${entry.ticket_id}`, entry]));
  for (const entry of source.metadata ?? []) {
    const sprint = sourceSprints.get(entry.sprint_id);
    const ticket = sprint?.tickets?.find((item) => item.id === entry.id);
    const deletion = deletedTickets.get(`${entry.sprint_id}:${entry.id}`);
    if (!registered.has(entry.sprint_id) && sprint && !ticket && deletion) excludedTickets.push({ ticket_id: entry.id, sprint_id: entry.sprint_id, deletion_event_id: deletion.event_id, deleted_at: deletion.timestamp });
    else if (!registered.has(entry.sprint_id) && sprint && !ticket) scopeDrift.set(entry.sprint_id, [...(scopeDrift.get(entry.sprint_id) ?? []), entry.id]);
    else if (!registered.has(entry.sprint_id) && !sprint) block("SPRINT_MIGRATION_ORPHAN_TICKET", entry.sprint_id);
    if (ticket && entry.latest && migrationHash(ticketMigrationContent(backfillTicketCandidates(ticket))) !== migrationHash(ticketMigrationContent(backfillTicketCandidates(entry.latest)))) block("SPRINT_MIGRATION_TICKET_DRIFT", entry.id);
    if (entry.latest && (entry.latest.project_id !== projectId || entry.latest.sprint_id !== entry.sprint_id || entry.latest.id !== entry.id)) block("SPRINT_MIGRATION_TICKET_OWNERSHIP", entry.id);
    if (!entry.latest) block("SPRINT_MIGRATION_TICKET_MISSING", entry.id);
  }
  for (const [sprintId, ticketIds] of scopeDrift) blockers.push({ code: "SPRINT_MIGRATION_TICKET_SCOPE_CONFLICT", identifier: sprintId, ticket_count: ticketIds.length, ticket_sample: ticketIds.sort().slice(0, 10) });
  for (const state of source.ticket_status ?? []) {
    if (["running", "reviewing", "working"].includes(state.status) || JSON.parse(state.details_json ?? "{}").launch_claim) block("SPRINT_MIGRATION_EXECUTION_UNRECONCILED", state.ticket_id);
  }
  for (const record of registryRecords) {
    if (record.status === "running") block("SPRINT_MIGRATION_EXECUTION_UNRECONCILED", record.sprint_id);
  }
  const basis = { project_id: projectId, source_sha256: migrationHash(source), registry_sha256: migrationHash(registryRecords), supplements: structuredClone(supplements), normalizations, excluded_tickets: excludedTickets.sort((a, b) => a.ticket_id.localeCompare(b.ticket_id)), entries, blockers };
  return { ...basis, manifest_sha256: migrationHash(basis), can_apply: blockers.length === 0 };
}
