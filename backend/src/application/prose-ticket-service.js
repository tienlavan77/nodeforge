// Parses natural-language ticket creation requests and validates against schemas.
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ConfigurationError } from "../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const ticketSchema = require("../../../schemas/governance/ticket.schema.json");

const INTENT = /\b(ticket|task|công việc|yêu cầu|implement|thêm|sửa|fix|build)\b/i;

// Creates a service that parses prose into validated tickets.
export function createProseTicketService({ roadmapStore, clock = () => new Date() } = {}) {
  if (typeof roadmapStore?.getCurrent !== "function" || typeof roadmapStore?.save !== "function") {
    throw new ConfigurationError("Prose ticket service requires a roadmap store.");
  }
  const validate = createValidator();
  async function regenerateEnglish(ticketId, { vietnameseContext, projectId, sprintLeader, ticketFileWriter, ticketStore } = {}) {
    if (!ticketId) throw new ConfigurationError("Ticket id is required for English regeneration.");
    const current = roadmapStore.getCurrent();
    if (!current) throw new ConfigurationError("Roadmap not found for regeneration.");
    const located = findTicket(current, ticketId);
    if (!located) throw new ConfigurationError(`Ticket not found: ${ticketId}`);
    const { ticket, sprint } = located;
    // Preserve original identity while updating Vietnamese context.
    const updatedVietnameseContext = vietnameseContext ?? ticket.context ?? ticket.vietnamese_context ?? "";
    // Dispatch to sprint leader for English-localized content (injected for testability).
    const sprintLeaderResult = sprintLeader && typeof sprintLeader.regenerateEnglish === "function"
      ? await sprintLeader.regenerateEnglish({ ticket: { ...ticket, context: updatedVietnameseContext }, projectId, sprintId: sprint.id, vietnameseContext: updatedVietnameseContext })
      : null;
    const baseEnglish = sprintLeaderResult ?? { title: ticket.title, objective: ticket.objective, acceptance_criteria: ticket.acceptance_criteria };
    // Ensure all translatable fields are English-localized and identity is preserved.
    const regenerated = {
      ...ticket,
      id: ticket.id,
      project_id: projectId ?? ticket.project_id,
      title: String(baseEnglish.title ?? ticket.title),
      objective: String(baseEnglish.objective ?? ticket.objective),
      acceptance_criteria: Array.isArray(baseEnglish.acceptance_criteria) ? baseEnglish.acceptance_criteria.map(String) : ticket.acceptance_criteria,
      context: updatedVietnameseContext,
      vietnamese_context: updatedVietnameseContext,
      original_vietnamese_context: updatedVietnameseContext,
      english_content: baseEnglish.english_content ?? baseEnglish.content_en ?? null,
      updated_at: clock().toISOString()
    };
    if (!validate(regenerated)) return validationResponse(validate.errors, regenerated);
    // Persist updated Vietnamese context to database via roadmap store.
    const nextRoadmap = updateTicketInRoadmap(current, regenerated);
    const savedRoadmap = roadmapStore.save(nextRoadmap);
    // Overwrite ticket file under .forge/runtime/nf/tickets for runtime propagation.
    if (ticketFileWriter && typeof ticketFileWriter.writeTicketFile === "function") {
      await ticketFileWriter.writeTicketFile(regenerated);
    } else if (ticketStore && typeof ticketStore.writeTicketFile === "function") {
      await ticketStore.writeTicketFile(regenerated);
    }
    // Propagate to DB ticket row if a dedicated ticketStore is available.
    if (ticketStore && typeof ticketStore.updateContext === "function") {
      await ticketStore.updateContext(regenerated.id, { context: updatedVietnameseContext, ticket: regenerated });
    }
    return { ticket: regenerated, roadmap: savedRoadmap };
  }
  function findTicket(roadmap, ticketId) {
    for (const sprint of roadmap.sprints ?? []) {
      for (const ticket of sprint.tickets ?? []) {
        if (ticket.id === ticketId) return { ticket, sprint };
      }
    }
    return null;
  }
  function updateTicketInRoadmap(roadmap, updatedTicket) {
    return {
      ...roadmap,
      version: nextAvailableVersion(roadmap.version, roadmapStore),
      updated_at: updatedTicket.updated_at,
      sprints: (roadmap.sprints ?? []).map((sprint) => sprint.id === updatedTicket.sprint_id ? { ...sprint, tickets: (sprint.tickets ?? []).map((item) => item.id === updatedTicket.id ? updatedTicket : item) } : sprint)
    };
  }

  return Object.freeze({ parse, createFromObject, regenerateEnglish });
  function createFromObject(ticket) {
    if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) return { create_ticket: true, status: "needs_input", error_code: "invalid_ticket_json", question: "Ticket JSON không hợp lệ." };
    if (!validate(ticket)) return validationResponse(validate.errors, ticket);
    return persist(ticket);
  }

  // Parses stored preferences JSON with fallback handling.
  function parse(text, { projectId, timestamp, sourceId } = {}) {
    const value = String(text ?? "").trim();
    if (!value || /^\/\S+/.test(value)) return { create_ticket: false };
    const structured = parseStructured(value);
    if (structured) {
      if (!validate(structured)) return invalidStructured(validate.errors, structured);
      return persist(structured);
    }
    if (!INTENT.test(value)) return { create_ticket: false };
    const fields = extract(value);
    const missing = ["title", "objective", "acceptance_criteria"].filter((field) => !fields[field]);
    if (missing.length) return { create_ticket: true, status: "needs_input", missing, question: `Vui lòng bổ sung: ${missing.join(", ")}.` };
    const now = timestamp ?? clock().toISOString();
    const current = roadmapStore.getCurrent();
    const roadmapId = current?.id ?? `ROADMAP-${projectId}`;
    const sprint = current?.sprints?.at(-1);
    const sprintId = sprint?.id ?? `SPRINT-${projectId}-CHAT`;
    const ticketId = fields.id ?? `TICKET-${projectId}-${Date.now()}`;
    const ticket = {
      id: ticketId, project_id: projectId, roadmap_id: roadmapId, sprint_id: sprintId,
      title: fields.title, objective: fields.objective, acceptance_criteria: fields.acceptance_criteria,
      ...(fields.priority ? { priority: fields.priority } : {}),
      ...(fields.dependencies?.length ? { dependencies: fields.dependencies } : {}),
      provenance: { source: "project_owner", source_id: sourceId ?? ticketId, created_at: now }
    };
    if (!validate(ticket)) return validationResponse(validate.errors, ticket);
    return persist(ticket);
  }
  function persist(ticket) {
    const current = roadmapStore.getCurrent();
    const next = current
      ? { ...current, version: nextAvailableVersion(current.version, roadmapStore), updated_at: ticket.provenance.created_at, sprints: appendToSprint(current.sprints, ticket) }
      : { id: ticket.roadmap_id, project_id: ticket.project_id, version: "1.0.0", created_at: ticket.provenance.created_at, sprints: [{ id: ticket.sprint_id, roadmap_id: ticket.roadmap_id, project_id: ticket.project_id, objective: ticket.objective, tickets: [ticket], exit_criteria: ["All planned tickets are complete."] }] };
    const roadmap = roadmapStore.save(next);
    return { create_ticket: true, status: "created", ticket, roadmap };
  }
  function appendToSprint(sprints, ticket) {
    let found = false;
    const updated = sprints.map((sprint) => {
      if (sprint.id !== ticket.sprint_id) return sprint;
      found = true;
      return { ...sprint, tickets: [...(sprint.tickets ?? []), ticket] };
    });
    if (!found) throw new ConfigurationError(`Sprint does not exist in roadmap: ${ticket.sprint_id}.`);
    return updated;
  }
  function invalidStructured(errors = [], value) {
    return validationResponse(errors, value);
  }
  function validationResponse(errors = [], value) {
    const missing = [...new Set(errors.filter((error) => error.keyword === "required").map((error) => error.params.missingProperty))];
    const invalid_fields = errors.filter((error) => error.keyword !== "required").map((error) => ({
      field: error.instancePath?.replace(/^\//, "") || error.params?.missingProperty || "ticket",
      keyword: error.keyword,
      value: error.instancePath ? readPointer(value, error.instancePath) : undefined,
      ...(error.keyword === "enum" ? { allowed_values: error.params.allowedValues } : {}),
      message: error.message
    }));
    const details = [
      ...(missing.length ? [`missing: ${missing.join(", ")}`] : []),
      ...invalid_fields.map((item) => item.keyword === "enum" ? `${item.field}=${JSON.stringify(item.value)}; allowed: ${item.allowed_values.join(", ")}` : `${item.field}: ${item.message}`)
    ];
    return { create_ticket: true, status: "needs_input", ...(missing.length ? { missing } : {}), ...(invalid_fields.length ? { invalid_fields } : {}), errors, question: details.length ? `Ticket chưa hợp lệ — ${details.join("; ")}.` : "Ticket chưa hợp lệ." };
  }
}

// Reads a value at a JSON pointer path.
function readPointer(value, pointer) {
  return pointer.slice(1).split("/").reduce((current, segment) => current?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")], value);
}

// Attempts to parse structured ticket JSON from text.
function parseStructured(value) {
  // Chat transport can append instructions after a valid JSON ticket. Parse only
  // the leading JSON value instead of treating those instructions as ticket text.
  const candidates = [];
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) candidates.push(leadingJsonValue(trimmed));
  const embeddedStart = trimmed.search(/[{[]/);
  if (embeddedStart > 0) candidates.push(leadingJsonValue(trimmed.slice(embeddedStart)));
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  if (fenced) candidates.push(fenced.trim());
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && !Array.isArray(parsed) && (parsed.id || parsed.title)) return parsed;
    } catch {
      // Fall through to prose extraction so malformed JSON gets a useful response.
    }
  }
  return null;
}

// Extracts the leading JSON object from a string.
function leadingJsonValue(value) {
  const opening = value[0];
  const closing = opening === "{" ? "}" : opening === "[" ? "]" : null;
  if (!closing) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === opening) depth += 1;
    else if (character === closing && --depth === 0) return value.slice(0, index + 1);
  }
  return null;
}

// Extracts ticket fields from prose text via regex.
function extract(text) {
  const value = (label) => text.match(new RegExp(`(?:^|\\n)\\s*(?:${label})\\s*:\\s*(.+)`, "i"))?.[1]?.trim();
  const criteria = text.match(/(?:^|\n)\s*(?:acceptance[_ ]criteria|criteria|tiêu chí)\s*:\s*([\s\S]+?)(?=\n\s*[a-z_ ]+\s*:|$)/i)?.[1]
    ?.split(/\n|;|\s*\|\s*/).map((item) => item.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
  return {
    id: value("id"), title: value("title|tiêu đề"), objective: value("objective|mục tiêu"),
    acceptance_criteria: criteria, priority: value("priority|ưu tiên"),
    dependencies: value("dependencies|depends_on|phụ thuộc")?.split(/[,\s]+/).filter(Boolean)
  };
}

// Finds the next available roadmap version.
function nextAvailableVersion(version, roadmapStore) {
  const existing = new Set(roadmapStore.getAllVersions?.().map(({ version: item }) => item) ?? []);
  let candidate = nextVersion(version);
  while (existing.has(candidate)) candidate = nextVersion(candidate);
  return candidate;
}

// Increments a semantic version patch number.
export function nextVersion(version = "1.0.0") {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return "1.0.1";
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3]) + 1}`;
}

// Creates a JSON schema validator for sprint plans and tickets.
function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(ticketSchema);
  return ajv.getSchema(ticketSchema.$id);
}
