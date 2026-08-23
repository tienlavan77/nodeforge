const COMMAND_PATTERN = /^\/ticket\s+([^\s]+)\s*$/i;
const TERMINAL_OR_ACTIVE = new Set(["running", "reviewing", "done"]);

/** Parses an owner chat ticket command and checks its dependency gate only. */
export function createTicketCommandParser({ roadmapStore } = {}) {
  if (typeof roadmapStore?.getCurrent !== "function") throw new TypeError("Ticket command parser requires roadmapStore.getCurrent.");
  return Object.freeze({ parse });

  function parse(text) {
    const match = String(text ?? "").match(COMMAND_PATTERN);
    if (!match) return { command: false };
    const ticketId = match[1];
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
    return roadmap?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((ticket) => ticket.id.toLowerCase() === String(id).toLowerCase());
  }
}

export function parseTicketCommand(text) {
  const match = String(text ?? "").match(COMMAND_PATTERN);
  return match ? { command: true, ticket_id: match[1] } : { command: false };
}

function summarize(ticket) {
  return { id: ticket.id, title: ticket.title, objective: ticket.objective, status: ticket.status ?? "pending", dependencies: ticket.depends_on ?? ticket.dependencies ?? [] };
}
