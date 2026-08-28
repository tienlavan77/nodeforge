import { ConfigurationError } from "../../shared/errors.js";

export function createTicketProvenanceTracker({ roadmaps, decisions } = {}) {
  if (typeof roadmaps?.getAllVersions !== "function" || typeof decisions?.getById !== "function") {
    throw new ConfigurationError("Ticket Provenance Tracker requires Roadmap and Architecture Decision stores.");
  }
  const tickets = new Map();

  return Object.freeze({ registerTicket, getProvenance, validateProvenance });

  function registerTicket(ticket) {
    const provenance = validateProvenance(ticket);
    if (tickets.has(ticket.id)) throw new ConfigurationError(`Ticket provenance already exists: ${ticket.id}.`);
    const stored = Object.freeze(structuredClone(provenance));
    tickets.set(ticket.id, stored);
    return structuredClone(stored);
  }

  function getProvenance(ticketId) {
    if (typeof ticketId !== "string" || ticketId.length === 0) throw new ConfigurationError("A ticket id is required.");
    const provenance = tickets.get(ticketId);
    return provenance ? structuredClone(provenance) : undefined;
  }

  function validateProvenance(ticket) {
    if (!ticket || typeof ticket !== "object" || typeof ticket.id !== "string" || typeof ticket.roadmap_id !== "string" || typeof ticket.sprint_id !== "string") {
      throw new ConfigurationError("Ticket provenance requires ticket, roadmap, and sprint identities.");
    }
    const roadmap = findRoadmap(ticket.roadmap_id);
    if (!roadmap) throw new ConfigurationError(`Roadmap does not exist: ${ticket.roadmap_id}.`);
    const sprint = roadmap.sprints.find(({ id }) => id === ticket.sprint_id);
    if (!sprint) throw new ConfigurationError(`Sprint does not exist in roadmap: ${ticket.sprint_id}.`);
    const canonicalTicket = sprint.tickets.find(({ id }) => id === ticket.id);
    if (!canonicalTicket) throw new ConfigurationError(`Ticket does not belong to sprint: ${ticket.id}.`);
    if (sprint.roadmap_id !== roadmap.id || canonicalTicket.roadmap_id !== roadmap.id || canonicalTicket.sprint_id !== sprint.id) {
      throw new ConfigurationError(`Ticket provenance chain is inconsistent: ${ticket.id}.`);
    }
    const architectureDecisionIds = roadmap.architecture_decision_ids ?? [];
    if (architectureDecisionIds.length === 0) throw new ConfigurationError(`Roadmap has no Architecture Decision provenance: ${roadmap.id}.`);
    const architectureDecisions = architectureDecisionIds.map((id) => {
      const decision = decisions.getById(id);
      if (!decision) throw new ConfigurationError(`Architecture Decision does not exist: ${id}.`);
      return decision;
    });
    return { architecture_decisions: architectureDecisions, roadmap, sprint, ticket: canonicalTicket };
  }

  function findRoadmap(id) {
    return roadmaps.getAllVersions().findLast((roadmap) => roadmap.id === id);
  }
}
