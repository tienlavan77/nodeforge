/* TICKET-PROJECT-NODEFORGE-1789479214703: regenerate English via Vietnamese source context -> sprint leader; validate -> persist -> sync runtime file */
/* TICKET-PROJECT-NODEFORGE-1789489861283: agent profile 'team' field supported via agent-profile-store persistence */
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";
import { backfillTicketCandidates, inferTicketStyle } from "../modules/index/ticket-scope.js";
import { extractTicketJson } from "./ticket-draft-parser.js";

const UPDATABLE = ["title", "objective", "acceptance_criteria", "priority", "dependencies", "status", "last_error", "style", "candidate_files", "candidates_produced_by", "candidates_produced_at"];
const SPRINT_LEADER_ROLE = "sprint_leader";

// Creates a CRUD service for tickets with sprint-leader normalization.
export function createTicketCrudService({ roadmaps, proseTicketService, ticketFileStore, publisher, agentStream, agentRoleResolver, candidateResolver, sprintLeader, clock = () => new Date(), logger = console } = {}) {
  if (typeof roadmaps?.getCurrent !== "function") throw new ConfigurationError("Ticket CRUD requires a Roadmap Store.");
  if (typeof proseTicketService?.createFromObject !== "function") throw new ConfigurationError("Ticket CRUD requires the Prose Ticket Service.");
  if (ticketFileStore !== undefined && typeof ticketFileStore?.create !== "function") throw new ConfigurationError("Ticket CRUD requires a valid Ticket File Store.");

  return Object.freeze({ listTickets, createTicket, updateTicket, regenerateTicketEnglish });
  function listTickets({ projectId } = {}) {
    requireProject(projectId);
    const current = roadmaps.getCurrent();
    if (!current || current.project_id !== projectId) return [];
    return structuredClone((current.sprints ?? []).flatMap((sprint) => sprint.tickets ?? []));
  }
  async function createTicket({ projectId, ticket, content, context, sprintId } = {}) {
    requireProject(projectId);
    const now = clock().toISOString();
    // Owner-entered text is private context. Normalize it before persistence so
    // the canonical ticket (and any downstream coder payload) is English only.
    const ownerContext = typeof context === "string" ? context : undefined;
    if (ownerContext !== undefined) {
      if ((typeof sprintLeader?.requestTicket !== "function" && typeof agentStream !== "function") || typeof agentRoleResolver?.resolve !== "function") {
        throw Object.assign(new ConfigurationError("Ticket normalization requires the Sprint Leader agent."), { statusCode: 503, code: "TICKET_NORMALIZER_UNAVAILABLE" });
      }
      let agentId;
      try { agentId = agentRoleResolver.resolve(SPRINT_LEADER_ROLE); } catch { throw Object.assign(new ConfigurationError("Ticket normalization requires the Sprint Leader agent."), { statusCode: 503, code: "TICKET_NORMALIZER_UNAVAILABLE" }); }
      const converted = await resolveSprintLeaderTicket({ projectId, agentId, content: ownerContext, ticket, feedback: undefined });
      if (!converted || typeof converted !== "object" || Array.isArray(converted)) {
        throw Object.assign(new ConfigurationError("Sprint leader response did not contain a valid ticket JSON object."), { statusCode: 422, code: "INVALID_TICKET" });
      }
      const normalized = tryCreate({ projectId, ticket: converted, sprintId, now });
      if (!normalized.created) throw attemptError(normalized);
      persistCanonical(normalized.ticket, ownerContext);
      return normalized;
    }
    const attempt = tryCreate({ projectId, ticket, content, sprintId, now });
    if (attempt.created) {
      persistCanonical(attempt.ticket, JSON.stringify(ticket ?? {}));
      return attempt;
    }

    // Structured tickets are created immediately; anything that fails
    // validation (raw chat or an invalid draft) goes through the sprint
    // leader, which must return a schema-valid ticket before creation.
    // Without agent wiring the original validation error is kept.
    if ((typeof sprintLeader?.requestTicket !== "function" && typeof agentStream !== "function") || typeof agentRoleResolver?.resolve !== "function") throw attemptError(attempt);
    let agentId;
    try { agentId = agentRoleResolver.resolve(SPRINT_LEADER_ROLE); } catch { throw attemptError(attempt); }

    const converted = await resolveSprintLeaderTicket({ projectId, agentId, content, ticket, feedback: attempt.question });
    if (!converted || typeof converted !== "object" || Array.isArray(converted)) {
      throw Object.assign(new ConfigurationError("Sprint leader response did not contain a valid ticket JSON object."), { statusCode: 422, code: "INVALID_TICKET" });
    }
    const retry = tryCreate({ projectId, ticket: converted, sprintId, now });
    if (retry.created) {
      persistCanonical(retry.ticket, typeof content === "string" ? content : JSON.stringify(ticket ?? {}));
      return retry;
    }
    throw Object.assign(new ConfigurationError(`Sprint leader returned an invalid ticket: ${retry.question ?? "unknown validation failure"}`), { statusCode: 422, code: "INVALID_TICKET", ...(retry.missing?.length ? { missing: retry.missing } : {}) });
  }
  function tryCreate({ projectId, ticket, content, sprintId, now }) {
    const current = roadmaps.getCurrent();
    let candidateInput = ticket;
    if (candidateInput === undefined && typeof content === "string") {
      const parsed = proseTicketService.parse(content, { projectId, timestamp: now, sourceId: `CONTENT-${Date.now()}` });
      if (parsed.status === "created" && parsed.ticket) candidateInput = parsed.ticket;
      else return { created: false, question: parsed.question ?? "Ticket content is invalid.", missing: parsed.missing };
    }
    if (!candidateInput || typeof candidateInput !== "object" || Array.isArray(candidateInput)) throw new ConfigurationError("ticket must be an object or content must be provided.");
    const id = candidateInput.id ?? `TICKET-${projectId}-${Date.now()}`;
    if (current?.sprints?.some((sprint) => (sprint.tickets ?? []).some((item) => item.id === id))) {
      throw Object.assign(new ConfigurationError(`Ticket already exists: ${id}.`), { statusCode: 409 });
    }
    const sprint = current?.sprints?.at(-1);
    const candidate = {
      ...candidateInput,
      id,
      project_id: projectId,
      roadmap_id: candidateInput.roadmap_id ?? current?.id ?? `ROADMAP-${projectId}`,
      sprint_id: sprintId ?? candidateInput.sprint_id ?? sprint?.id ?? `SPRINT-${projectId}-API`,
      provenance: candidateInput.provenance ?? { source: "project_owner", source_id: id, created_at: now }
    };
    const result = proseTicketService.createFromObject(candidate);
    if (result.status !== "created") {
      return { created: false, question: result.question ?? "Ticket is invalid.", invalid_fields: result.invalid_fields, missing: result.missing };
    }
    publish("ticket.created", projectId, { ticket_id: id, ticket: result.ticket, roadmap_version: result.roadmap.version });
    return { created: true, ticket: result.ticket, roadmap_version: result.roadmap.version };
  }
  function persistCanonical(ticket, context) {
    if (!ticketFileStore) return;
    ticketFileStore.create({ ticket, context });
  }
  // Sprint leader drafts through the SDK with built-in search: it verifies
  // paths with Read before citing, so its candidate_files are kept as-is.
  // The legacy text-only path has no codebase access, so anything path-like
  // it invents is stripped and resolved server-side instead.
  async function resolveSprintLeaderTicket({ projectId, agentId, content, ticket, feedback }) {
    const viaSdk = typeof sprintLeader?.requestTicket === "function";
    const draft = await requestSprintLeaderTicket({ projectId, agentId, content, ticket, feedback });
    if (!draft) return draft;
    if (viaSdk) return stampSdkDraft(draft);
    const textOnly = { ...draft };
    delete textOnly.candidate_files;
    delete textOnly.candidates_produced_by;
    delete textOnly.candidates_produced_at;
    if (typeof candidateResolver?.resolve === "function") return candidateResolver.resolve(textOnly);
    return styleAndBackfill(draft);
  }
  // Stamps an SDK draft, keeping the leader's own verified candidates.
  function stampSdkDraft(draft) {
    const stamped = { ...draft };
    if (!Array.isArray(stamped.style) || !stamped.style.length) {
      const inferred = inferTicketStyle(stamped);
      if (inferred) stamped.style = inferred;
    }
    if (Array.isArray(stamped.candidate_files) && stamped.candidate_files.length) {
      if (!stamped.candidates_produced_by) stamped.candidates_produced_by = "sprint-leader-sdk";
      if (!stamped.candidates_produced_at) stamped.candidates_produced_at = clock().toISOString();
      return stamped;
    }
    if (typeof candidateResolver?.resolve === "function") return candidateResolver.resolve(stamped);
    return backfillTicketCandidates(stamped, { now: () => clock().toISOString() });
  }
  // Infers style then attaches a marked placeholder for legacy drafts.
  function styleAndBackfill(draft) {
    const styled = { ...draft };
    if (!Array.isArray(styled.style) || !styled.style.length) {
      const inferred = inferTicketStyle(styled);
      if (inferred) styled.style = inferred;
    }
    return backfillTicketCandidates(styled, { now: () => clock().toISOString() });
  }
  async function requestSprintLeaderTicket({ projectId, agentId, content, ticket, feedback }) {
    if (typeof sprintLeader?.requestTicket === "function") {
      return sprintLeader.requestTicket({ projectId, agentId, content, ticket, feedback, correlationId: `CORR-TICKET-CREATE-${randomUUID()}` });
    }
    const prompt = [
      "Convert the project owner request below into exactly one governance ticket.",
      "Write ALL ticket field values (title, objective, acceptance_criteria) in English. If the owner request is in another language (e.g. Vietnamese), translate it into clear technical English.",
      "REQUIRED: Infer ticket style as a non-empty array of strings. Valid values: frontend (UI/component/page/accordion/modal/chat UI), backend (api/endpoint/database/server), security (auth/permission/credential), infra (deploy/docker/pipeline), docs (documentation). Every ticket MUST include style with at least one value; return e.g. [\"frontend\"] or [\"frontend\",\"backend\"]. Do NOT omit style.",
      "Respond with ONLY one ```json fenced block containing the ticket JSON object. No prose outside the block.",
      "Ticket fields: title (string, required), objective (string, required), acceptance_criteria (array of strings, at least one, required), style (array of strings, REQUIRED, at least one: frontend|backend|security|infra|docs), priority (optional: low|medium|normal|high|critical), dependencies (optional: array of ticket ids).",
      "You have no codebase access so never invent file paths. Do NOT include candidate_files, candidates_produced_by, candidates_produced_at, id, project_id, roadmap_id, sprint_id, status, last_error, or provenance; the system resolves real codebase files server-side and assigns identity fields.",
      feedback ? `Previous validation feedback: ${feedback}` : undefined,
      `Project id: ${projectId}`,
      content ? `Owner request (raw chat):\n${content}` : undefined,
      ticket ? `Owner draft ticket JSON that failed validation:\n${JSON.stringify(ticket, null, 2)}` : undefined
    ].filter((line) => line !== undefined).join("\n\n");
    let output = "";
    for await (const chunk of agentStream({ agentId, payload: { text: prompt, tools: [] }, correlationId: `CORR-TICKET-CREATE-${randomUUID()}` })) {
      if (typeof chunk?.text === "string") output += chunk.text;
    }
    return extractTicketJson(output);
  }
  async function regenerateTicketEnglish({ projectId, ticketId, context, sprintId } = {}) {
    requireProject(projectId);
    if (typeof context !== "string" || !context.trim()) throw Object.assign(new ConfigurationError("Vietnamese source context is required."), { statusCode: 400, code: "SOURCE_CONTEXT_REQUIRED" });
    const current = roadmaps.getCurrent();
    const original = current?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((ticket) => ticket.id === ticketId && ticket.project_id === projectId);
    if (!original) throw Object.assign(new ConfigurationError(`Unknown ticket: ${ticketId}.`), { statusCode: 404 });
    if ((typeof sprintLeader?.requestTicket !== "function" && typeof agentStream !== "function") || typeof agentRoleResolver?.resolve !== "function") throw Object.assign(new ConfigurationError("English regeneration requires the Sprint Leader agent."), { statusCode: 503, code: "TICKET_REGENERATOR_UNAVAILABLE" });
    let agentId;
    try { agentId = agentRoleResolver.resolve(SPRINT_LEADER_ROLE); } catch { throw Object.assign(new ConfigurationError("English regeneration requires the Sprint Leader agent."), { statusCode: 503, code: "TICKET_REGENERATOR_UNAVAILABLE" }); }
    let converted;
    try {
      converted = await resolveSprintLeaderTicket({ projectId, agentId, content: context, ticket: undefined, feedback: `Regenerate ticket ${ticketId}; preserve its identity and translate every translatable field to English.` });
    } catch (error) {
      throw Object.assign(new ConfigurationError(`Sprint leader regeneration failed: ${error.message}`), { statusCode: 503, code: "TICKET_REGENERATOR_UNAVAILABLE", cause: error });
    }
    if (!converted) throw Object.assign(new ConfigurationError("Sprint leader did not return a ticket JSON object."), { statusCode: 422, code: "INVALID_REGENERATED_TICKET" });
    const candidate = { ...original, ...converted, id: ticketId, project_id: projectId, sprint_id: sprintId ?? original.sprint_id, roadmap_id: original.roadmap_id, provenance: original.provenance };
    const errors = validateRegeneratedTicket(candidate);
    if (errors.length) throw Object.assign(new ConfigurationError(`Regenerated ticket failed validation: ${errors.join("; ")}`), { statusCode: 422, code: "INVALID_REGENERATED_TICKET" });
    const saved = roadmaps.updateTicket({ projectId, ticketId, patch: Object.fromEntries(UPDATABLE.filter((field) => candidate[field] !== undefined).map((field) => [field, candidate[field]])) });
    if (!saved) throw Object.assign(new ConfigurationError(`Could not persist regenerated ticket: ${ticketId}.`), { statusCode: 500, code: "TICKET_PERSISTENCE_FAILED" });
    const updated = saved.sprints.flatMap((sprint) => sprint.tickets ?? []).find((ticket) => ticket.id === ticketId);
    if (!updated) throw Object.assign(new ConfigurationError(`Could not read persisted regenerated ticket: ${ticketId}.`), { statusCode: 500, code: "TICKET_PERSISTENCE_FAILED" });
    try {
      const synchronized = ticketFileStore?.update?.({ ticket: updated, context });
      if (synchronized === false) throw new Error("Ticket file store rejected the update.");
    } catch (error) { throw Object.assign(new ConfigurationError(`Could not synchronize runtime ticket file: ${error.message}`), { statusCode: 500, code: "TICKET_RUNTIME_SYNC_FAILED", cause: error }); }
    publish("ticket.updated", projectId, { ticket_id: ticketId, ticket: updated, reason: "english_regeneration" });
    return { updated: true, ticket: updated, english_content: ticketEnglishContent(updated), source_context: context };
  }
  function updateTicket({ projectId, ticketId, patch } = {}) {
    requireProject(projectId);
    const provided = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
    const filtered = Object.fromEntries(UPDATABLE.filter((field) => provided[field] !== undefined).map((field) => [field, provided[field]]));
    if (filtered.style === undefined && (filtered.title || filtered.objective || filtered.acceptance_criteria)) {
      const current = roadmaps.getCurrent();
      const existing = current?.sprints?.flatMap(s => s.tickets ?? []).find(t => t.id === ticketId);
      const merged = { ...(existing ?? {}), ...filtered };
      const inferred = inferTicketStyle(merged);
      if (inferred) filtered.style = inferred;
    }
    const saved = roadmaps.updateTicket?.({ projectId, ticketId, patch: filtered });
    if (saved === undefined) throw Object.assign(new ConfigurationError(`Unknown ticket: ${ticketId}.`), { statusCode: 404 });
    const updated = saved.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id === ticketId);
    ticketFileStore?.update({ ticket: updated });
    publish("ticket.updated", projectId, { ticket_id: ticketId, ticket: updated, roadmap_version: saved.version, patch: filtered });
    return { updated: true, ticket: updated, roadmap_version: saved.version };
  }
  function attemptError(attempt) {
    return Object.assign(new ConfigurationError(attempt.question ?? "Ticket is invalid."), { statusCode: 422, code: "INVALID_TICKET", ...(attempt.invalid_fields?.length ? { invalid_fields: attempt.invalid_fields } : {}), ...(attempt.missing?.length ? { missing: attempt.missing } : {}) });
  }
  function publish(type, projectId, payload) {
    try { publisher?.publish?.({ event_id: `EVT-${Date.now()}-${type}`, type, project_id: projectId, timestamp: new Date().toISOString(), payload, metadata: { source: "ticket-crud-service" } }); } catch (error) { logger.error?.("Ticket event publisher failed after mutation.", { entity_id: payload?.ticket_id ?? payload?.ticket?.id, event_name: type, error: error.message }); /* stream notification must not undo mutation */ }
  }
}

// Formats ticket fields into English content string.
function ticketEnglishContent(ticket) {
  return [ticket.title ? `Title: ${ticket.title}` : "", ticket.objective ? `Objective: ${ticket.objective}` : "", (ticket.acceptance_criteria ?? []).length ? `Acceptance criteria:\n${ticket.acceptance_criteria.map((item) => `- ${item}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
}

// Validates regenerated ticket required fields.
function validateRegeneratedTicket(ticket) {
  const errors = [];
  for (const field of ["title", "objective"]) if (typeof ticket[field] !== "string" || !ticket[field].trim()) errors.push(`${field} must be a non-empty string`);
  if (!Array.isArray(ticket.acceptance_criteria) || ticket.acceptance_criteria.length === 0 || ticket.acceptance_criteria.some((item) => typeof item !== "string" || !item.trim())) errors.push("acceptance_criteria must contain non-empty strings");
  if (!Array.isArray(ticket.candidate_files) || ticket.candidate_files.length === 0) errors.push("candidate_files must contain at least one entry");
  for (const entry of ticket.candidate_files ?? []) {
    if ((entry?.role === "PATCH" || entry?.role === "REUSE") && (typeof entry?.symbol !== "string" || !entry.symbol.trim())) errors.push(`candidate_files entry ${entry?.path ?? "?"} with role ${entry?.role} must include a symbol`);
  }
  if (ticket.priority !== undefined && !["low", "medium", "normal", "high", "critical"].includes(ticket.priority)) errors.push("priority is invalid");
  return errors;
}

// Validates that a project ID is provided.
function requireProject(projectId) {
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw Object.assign(new ConfigurationError("A project id is required."), { statusCode: 400, code: "PROJECT_REQUIRED" });
  }
}

