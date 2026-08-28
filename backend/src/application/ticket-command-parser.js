const COMMAND_PATTERN = /^\/ticket\s+([\s\S]+?)\s*$/i;
const TERMINAL_OR_ACTIVE = new Set(["running", "reviewing", "done"]);

/** Parses an owner chat ticket command and checks its dependency gate only. */
export function createTicketCommandParser({ roadmapStore } = {}) {
  if (typeof roadmapStore?.getCurrent !== "function") throw new TypeError("Ticket command parser requires roadmapStore.getCurrent.");
  return Object.freeze({ parse });

  function parse(text) {
    const raw = String(text ?? "").trim();
    if (!/^\/ticket(?:\s|$)/i.test(raw)) return { command: false };
    const match = raw.match(COMMAND_PATTERN);
    if (!match) return { command: true, status: "syntax_error", error: "Không nhận diện được ticket id, vui lòng kiểm tra lại cú pháp /ticket <id>." };
    const ticketId = match[1].replace(/\s+/g, "");
    if (!ticketId) return { command: true, status: "syntax_error", error: "Không nhận diện được ticket id, vui lòng kiểm tra lại cú pháp /ticket <id>." };
    const ticket = findTicket(roadmapStore.getCurrent(), ticketId);
    if (!ticket) return { command: true, ticket_id: ticketId, status: "not_found", error: `Ticket not found: ${ticketId}.` };
    const currentStatus = String(ticket.status ?? "pending").toLowerCase();
    if (TERMINAL_OR_ACTIVE.has(currentStatus)) return { command: true, ticket_id: ticket.id, status: currentStatus, ticket: summarize(ticket) };
    const dependencies = ticket.depends_on ?? ticket.dependencies ?? [];
    const missing = dependencies.map((id) => ({ id, ticket: findTicket(roadmapStore.getCurrent(), id) })).filter(({ ticket: dependency }) => !dependency || String(dependency.status ?? "pending").toLowerCase() !== "done").map(({ id, ticket: dependency }) => ({ id, status: dependency?.status ?? "not_found" }));
    if (missing.length) return { command: true, ticket_id: ticket.id, status: "blocked", blocked_by: missing, ticket: summarize(ticket) };
    return { command: true, ticket_id: ticket.id, status: "ready", dependencies: dependencies.map((id) => ({ id, status: "done" })), ticket: summarize(ticket) };
  }

  function findTicket(roadmap, id) {
    // Duplicate IDs are historically allowed; dispatch the newest matching record.
    const matches = roadmap?.sprints?.flatMap((sprint) => sprint.tickets ?? []).filter((ticket) => ticket.id.toLowerCase() === String(id).toLowerCase()) ?? [];
    return matches.at(-1);
  }
}

export function parseTicketCommand(text) {
  const raw = String(text ?? "").trim();
  if (!/^\/ticket(?:\s|$)/i.test(raw)) return { command: false };
  const match = raw.match(COMMAND_PATTERN);
  if (!match) return { command: true, status: "syntax_error", error: "Không nhận diện được ticket id, vui lòng kiểm tra lại cú pháp /ticket <id>." };
  const ticketId = match[1].replace(/\s+/g, "");
  return ticketId ? { command: true, ticket_id: ticketId } : { command: true, status: "syntax_error", error: "Không nhận diện được ticket id, vui lòng kiểm tra lại cú pháp /ticket <id>." };
}

function summarize(ticket) {
  return {
    id: ticket.id,
    title: ticket.title,
    objective: ticket.objective,
    acceptance_criteria: ticket.acceptance_criteria ?? [],
    status: ticket.status ?? "pending",
    dependencies: ticket.depends_on ?? ticket.dependencies ?? [],
    ...(ticket.project_id ? { project_id: ticket.project_id } : {}),
    ...(ticket.roadmap_id ? { roadmap_id: ticket.roadmap_id } : {}),
    ...(ticket.sprint_id ? { sprint_id: ticket.sprint_id } : {}),
    ...(ticket.priority ? { priority: ticket.priority } : {}),
    ...(ticket.provenance ? { provenance: ticket.provenance } : {})
  };
}
