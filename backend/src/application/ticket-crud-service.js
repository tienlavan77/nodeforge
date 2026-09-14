import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";

const UPDATABLE = ["title", "objective", "acceptance_criteria", "priority", "dependencies", "status", "last_error"];
const SPRINT_LEADER_ROLE = "sprint_leader";

export function createTicketCrudService({ roadmaps, proseTicketService, publisher, agentStream, agentRoleResolver, clock = () => new Date() } = {}) {
  if (typeof roadmaps?.getCurrent !== "function") throw new ConfigurationError("Ticket CRUD requires a Roadmap Store.");
  if (typeof proseTicketService?.createFromObject !== "function") throw new ConfigurationError("Ticket CRUD requires the Prose Ticket Service.");

  return Object.freeze({ listTickets, createTicket, updateTicket });

  function listTickets({ projectId } = {}) {
    requireProject(projectId);
    const current = roadmaps.getCurrent();
    if (!current || current.project_id !== projectId) return [];
    return structuredClone((current.sprints ?? []).flatMap((sprint) => sprint.tickets ?? []));
  }

  async function createTicket({ projectId, ticket, content, sprintId } = {}) {
    requireProject(projectId);
    const now = clock().toISOString();
    const attempt = tryCreate({ projectId, ticket, content, sprintId, now });
    if (attempt.created) return attempt;

    // Structured tickets are created immediately; anything that fails
    // validation (raw chat or an invalid draft) goes through the sprint
    // leader, which must return a schema-valid ticket before creation.
    // Without agent wiring the original validation error is kept.
    if (typeof agentStream !== "function" || typeof agentRoleResolver?.resolve !== "function") throw attemptError(attempt);
    let agentId;
    try { agentId = agentRoleResolver.resolve(SPRINT_LEADER_ROLE); } catch { throw attemptError(attempt); }

    const converted = await requestSprintLeaderTicket({ projectId, agentId, content, ticket, feedback: attempt.question });
    if (!converted || typeof converted !== "object" || Array.isArray(converted)) {
      throw Object.assign(new ConfigurationError("Sprint leader response did not contain a valid ticket JSON object."), { statusCode: 422, code: "INVALID_TICKET" });
    }
    const retry = tryCreate({ projectId, ticket: converted, sprintId, now });
    if (retry.created) return retry;
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

  async function requestSprintLeaderTicket({ projectId, agentId, content, ticket, feedback }) {
    const prompt = [
      "Convert the project owner request below into exactly one governance ticket.",
      "Write ALL ticket field values (title, objective, acceptance_criteria) in English. If the owner request is in another language (e.g. Vietnamese), translate it into clear technical English.",
      "Respond with ONLY one ```json fenced block containing the ticket JSON object. No prose outside the block.",
      "Ticket fields: title (string, required), objective (string, required), acceptance_criteria (array of strings, at least one, required), priority (optional: low|medium|normal|high|critical), dependencies (optional: array of ticket ids).",
      "Do NOT include id, project_id, roadmap_id, sprint_id, status, last_error, or provenance; the system assigns them.",
      feedback ? `Previous validation feedback: ${feedback}` : undefined,
      `Project id: ${projectId}`,
      content ? `Owner request (raw chat):\n${content}` : undefined,
      ticket ? `Owner draft ticket JSON that failed validation:\n${JSON.stringify(ticket, null, 2)}` : undefined
    ].filter((line) => line !== undefined).join("\n\n");
    let output = "";
    for await (const chunk of agentStream({ agentId, payload: { text: prompt }, correlationId: `CORR-TICKET-CREATE-${randomUUID()}` })) {
      if (typeof chunk?.text === "string") output += chunk.text;
    }
    return extractTicketJson(output);
  }

  function updateTicket({ projectId, ticketId, patch } = {}) {
    requireProject(projectId);
    const provided = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
    const filtered = Object.fromEntries(UPDATABLE.filter((field) => provided[field] !== undefined).map((field) => [field, provided[field]]));
    const saved = roadmaps.updateTicket?.({ projectId, ticketId, patch: filtered });
    if (saved === undefined) throw Object.assign(new ConfigurationError(`Unknown ticket: ${ticketId}.`), { statusCode: 404 });
    const updated = saved.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id === ticketId);
    publish("ticket.updated", projectId, { ticket_id: ticketId, ticket: updated, roadmap_version: saved.version, patch: filtered });
    return { updated: true, ticket: updated, roadmap_version: saved.version };
  }

  function attemptError(attempt) {
    return Object.assign(new ConfigurationError(attempt.question ?? "Ticket is invalid."), { statusCode: 422, code: "INVALID_TICKET", ...(attempt.invalid_fields?.length ? { invalid_fields: attempt.invalid_fields } : {}), ...(attempt.missing?.length ? { missing: attempt.missing } : {}) });
  }

  function publish(type, projectId, payload) {
    try { publisher?.publish?.({ event_id: `EVT-${Date.now()}-${type}`, type, project_id: projectId, timestamp: new Date().toISOString(), payload, metadata: { source: "ticket-crud-service" } }); } catch { /* stream notification must not undo mutation */ }
  }
}

function requireProject(projectId) {
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw Object.assign(new ConfigurationError("A project id is required."), { statusCode: 400, code: "PROJECT_REQUIRED" });
  }
}

function extractTicketJson(text) {
  const value = String(text ?? "");
  const candidates = [];
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  if (fenced?.trim()) candidates.push(fenced.trim());
  const start = value.search(/[{[]/);
  if (start >= 0) candidates.push(value.slice(start));
  for (const candidate of candidates) {
    const parsed = parseLeadingJson(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

function parseLeadingJson(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      try { const parsed = JSON.parse(trimmed.slice(0, index + 1)); return parsed && !Array.isArray(parsed) ? parsed : undefined; } catch { return undefined; }
    }
  }
  return undefined;
}
