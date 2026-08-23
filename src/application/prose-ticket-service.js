import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ConfigurationError } from "../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../schemas/core/common.schema.json");
const ticketSchema = require("../../schemas/governance/ticket.schema.json");

const INTENT = /\b(ticket|task|công việc|yêu cầu|implement|thêm|sửa|fix|build)\b/i;

export function createProseTicketService({ roadmapStore, clock = () => new Date() } = {}) {
  if (typeof roadmapStore?.getCurrent !== "function" || typeof roadmapStore?.save !== "function") {
    throw new ConfigurationError("Prose ticket service requires a roadmap store.");
  }
  const validate = createValidator();
  return Object.freeze({ parse });

  function parse(text, { projectId, timestamp, sourceId } = {}) {
    const value = String(text ?? "").trim();
    if (!value || /^\/\S+/.test(value)) return { create_ticket: false };
    const structured = parseStructured(value);
    if (structured) {
      if (!validate(structured)) return invalidStructured(validate.errors);
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
    if (!validate(ticket)) return { create_ticket: true, status: "needs_input", missing: ["valid ticket fields"], errors: validate.errors };
    return persist(ticket);
  }

  function persist(ticket) {
    const current = roadmapStore.getCurrent();
    const next = current
      ? { ...current, version: nextVersion(current.version), updated_at: ticket.provenance.created_at, sprints: current.sprints.map((item, index) => index === current.sprints.length - 1 ? { ...item, tickets: [...(item.tickets ?? []), ticket] } : item) }
      : { id: ticket.roadmap_id, project_id: ticket.project_id, version: "1.0.0", created_at: ticket.provenance.created_at, sprints: [{ id: ticket.sprint_id, roadmap_id: ticket.roadmap_id, project_id: ticket.project_id, objective: ticket.objective, tickets: [ticket], exit_criteria: ["All planned tickets are complete."] }] };
    const roadmap = roadmapStore.save(next);
    return { create_ticket: true, status: "created", ticket, roadmap };
  }

  function invalidStructured(errors = []) {
    const missing = errors.filter((error) => error.keyword === "required").map((error) => error.params.missingProperty);
    return { create_ticket: true, status: "needs_input", missing: [...new Set(missing)], errors };
  }
}

function parseStructured(value) {
  if (!value.startsWith("{") && !value.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && !Array.isArray(parsed) && (parsed.id || parsed.title) ? parsed : null;
  } catch {
    return null;
  }
}

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

function nextVersion(version = "1.0.0") {
  const parts = String(version).split(".").map(Number);
  return `${parts[0] || 1}.${parts[1] || 0}.${(parts[2] || 0) + 1}`;
}

function createValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(ticketSchema);
  return ajv.getSchema(ticketSchema.$id);
}
