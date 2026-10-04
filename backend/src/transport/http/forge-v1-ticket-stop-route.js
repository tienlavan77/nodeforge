// Handles a ticket Stop request while preserving its checkpoint for retry.
import { unavailable, requireProject } from "./forge-v1-router-utils.js";

// Routes an active ticket Stop request to the running dispatch controller.
export function routeTicketStop({ method, parts, projectId, dispatchTicket }) {
  if (method !== "POST" || parts.length !== 2 || parts[0] !== "tickets" || !parts[1].endsWith(":stop")) return null;
  requireProject(projectId);
  if (typeof dispatchTicket?.stop !== "function") throw unavailable("Ticket Stop");
  return { status: 202, body: dispatchTicket.stop({ projectId, ticketId: parts[1].slice(0, -5) }) };
}
