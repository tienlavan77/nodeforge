// Planner that selects current sprint, generates and prioritizes tickets, and publishes them on the bus.
import { ConfigurationError } from "../../shared/errors.js";

const PRIORITY = new Map([["critical", 0], ["high", 1], ["normal", 2], ["low", 3]]);

// Creates a planner that builds ticket batches from the sprint projection.
export function createSprintLeaderPlanner({ projection, graph, provenance, bus, leaderId = "SPRINT-LEADER", nodeId = "NODE" } = {}) {
  if (typeof projection?.getCurrentSprint !== "function" || typeof projection?.getSprintBacklog !== "function" || typeof graph?.addNode !== "function" || typeof graph?.addDependency !== "function" || typeof graph?.getExecutionOrder !== "function" || typeof provenance?.registerTicket !== "function" || typeof bus?.send !== "function") {
    throw new ConfigurationError("Sprint Leader Planner requires projection, dependency graph, provenance tracker, and communication bus.");
  }
  const generated = new Map();
  const graphNodes = new Set();
  const published = new Set();

  return Object.freeze({ selectCurrentSprint, generateTickets, prioritizeBacklog, publishTickets });

  // Returns the currently active sprint from the projection.
  function selectCurrentSprint() {
    return structuredClone(projection.getCurrentSprint());
  }

  // Generates frozen ticket records for the current sprint backlog.
  function generateTickets() {
    const sprint = selectCurrentSprint();
    if (!sprint) throw new ConfigurationError("No current Sprint Plan is available.");
    const backlog = projection.getSprintBacklog(sprint.id);
    ensureGraph(sprint, backlog);
    return backlog.map((ticket) => {
      const existing = generated.get(ticket.id);
      if (existing) return structuredClone(existing);
      provenance.registerTicket(ticket);
      const stored = Object.freeze(structuredClone(ticket));
      generated.set(stored.id, stored);
      return structuredClone(stored);
    });
  }

  // Sorts tickets by priority then lexicographic id.
  function prioritizeBacklog(tickets = generateTickets()) {
    if (!Array.isArray(tickets)) throw new ConfigurationError("Sprint backlog must be an array.");
    return tickets.map((ticket) => structuredClone(ticket)).sort((left, right) => (
      priorityOf(left) - priorityOf(right) || left.id.localeCompare(right.id)
    ));
  }

  // Publishes each ticket as a governance message on the bus.
  function publishTickets(tickets = prioritizeBacklog()) {
    if (!Array.isArray(tickets)) throw new ConfigurationError("Tickets to publish must be an array.");
    const sent = [];
    for (const ticket of tickets) {
      if (published.has(ticket.id)) continue;
      const message = bus.send({
        id: `MSG-SPRINT-LEADER-TICKET-${ticket.id}`,
        project_id: ticket.project_id,
        sender: { id: leaderId, role: "sprint_lead" },
        recipient: { id: nodeId, role: "node" },
        message_type: "governance.ticket.created",
        payload: { ticket: structuredClone(ticket) },
        timestamp: ticket.provenance.created_at
      });
      published.add(ticket.id);
      sent.push(message);
    }
    return sent;
  }

  // Populates the dependency graph from roadmap, sprint, and ticket relations.
  function ensureGraph(sprint, tickets) {
    const roadmapId = sprint.roadmap_id;
    addGraphNode({ id: roadmapId, type: "roadmap" });
    addGraphNode({ id: sprint.id, type: "sprint" });
    graph.addDependency(sprint.id, roadmapId);
    for (const ticket of tickets) addGraphNode({ id: ticket.id, type: "ticket" });
    for (const ticket of tickets) {
      graph.addDependency(ticket.id, sprint.id);
      for (const dependencyId of ticket.dependencies ?? []) graph.addDependency(ticket.id, dependencyId);
    }
    graph.getExecutionOrder();
  }

  // Adds a graph node if not already tracked.
  function addGraphNode(node) {
    if (graphNodes.has(node.id)) return;
    graph.addNode(node);
    graphNodes.add(node.id);
  }
}

// Maps a ticket priority to its sort weight.
function priorityOf(ticket) {
  return PRIORITY.get(ticket.priority ?? "normal") ?? PRIORITY.get("normal");
}
