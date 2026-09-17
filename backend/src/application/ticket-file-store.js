import { join } from "node:path";

import { ConfigurationError } from "../shared/errors.js";

const TICKET_ROOT = join(".forge", "runtime", "nf", "tickets");

// The JSONL stream is an append-only canonical history. SQLite contains only
// lookup metadata and the owner's private source context.
export function createTicketFileStore({ database, fileService, clock = () => new Date() } = {}) {
  if (typeof database?.run !== "function" || typeof database?.all !== "function") throw new ConfigurationError("Ticket File Store requires a SQLite database.");
  if (typeof fileService?.appendFileSync !== "function" || typeof fileService?.readFileSync !== "function") throw new ConfigurationError("Ticket File Store requires FileService persistence.");

  return Object.freeze({ create, update, getMetadata, listMetadata, readLatest });
  function create({ ticket, context } = {}) {
    assertTicket(ticket);
    const now = ticket.provenance?.created_at ?? clock().toISOString();
    const ticketFile = pathFor(ticket.id);
    append(ticketFile, { type: "ticket.created", ticket, timestamp: now });
    database.run(`INSERT INTO tickets (
      id, project_id, roadmap_id, sprint_id, context, status, ticket_file, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      ticket.id, ticket.project_id, ticket.roadmap_id, ticket.sprint_id, String(context ?? ""), ticket.status ?? "pending", ticketFile, now, now
    ]);
    return getMetadata(ticket.id);
  }
  function update({ ticket, context } = {}) {
    assertTicket(ticket);
    const existing = getMetadata(ticket.id);
    if (!existing) throw new ConfigurationError(`Unknown ticket metadata: ${ticket.id}.`);
    const now = clock().toISOString();
    append(existing.ticket_file, { type: "ticket.updated", ticket, timestamp: now });
    const nextContext = context === undefined ? existing.context : String(context ?? "");
    database.run("UPDATE tickets SET context = ?, status = ?, updated_at = ? WHERE id = ?", [nextContext, ticket.status ?? existing.status, now, ticket.id]);
    return getMetadata(ticket.id);
  }
  function getMetadata(ticketId) {
    if (typeof ticketId !== "string" || !ticketId) throw new ConfigurationError("A ticket id is required.");
    return database.all("SELECT id, project_id, roadmap_id, sprint_id, context, status, ticket_file, created_at, updated_at FROM tickets WHERE id = ?", [ticketId])[0];
  }
  function listMetadata({ projectId, sprintId } = {}) {
    if (typeof projectId !== "string" || !projectId) throw new ConfigurationError("A project id is required.");
    const where = sprintId ? "WHERE project_id = ? AND sprint_id = ?" : "WHERE project_id = ?";
    return database.all(`SELECT id, project_id, roadmap_id, sprint_id, context, status, ticket_file, created_at, updated_at FROM tickets ${where} ORDER BY updated_at`, sprintId ? [projectId, sprintId] : [projectId]);
  }
  function readLatest(ticketId) {
    const metadata = getMetadata(ticketId);
    if (!metadata) return undefined;
    const lines = fileService.readFileSync({ path: metadata.ticket_file }).trim().split("\n").filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = JSON.parse(lines[index]);
      if (record?.ticket?.id === ticketId) return structuredClone(record.ticket);
    }
    return undefined;
  }
  function append(ticketFile, record) {
    fileService.appendFileSync({ path: ticketFile, content: `${JSON.stringify(record)}\n` });
  }
}

// Builds the ticket file path for a given ticket ID.
function pathFor(ticketId) {
  if (!/^[A-Za-z0-9._-]+$/.test(ticketId)) throw new ConfigurationError("Ticket id contains unsafe file characters.");
  return join(TICKET_ROOT, `${ticketId}.jsonl`);
}

// Validates that a ticket has required identity fields.
function assertTicket(ticket) {
  if (!ticket || typeof ticket !== "object" || !ticket.id || !ticket.project_id || !ticket.roadmap_id || !ticket.sprint_id) {
    throw new ConfigurationError("Ticket file storage requires a complete canonical ticket.");
  }
}
