import { ConfigurationError } from "../../shared/errors.js";

export function createArchitectureManager({ decisions, knowledge, roadmaps, bus, managerId = "ARCHITECTURE-MANAGER", nodeId = "NODE" } = {}) {
  if (typeof decisions?.append !== "function" || typeof roadmaps?.save !== "function" || typeof knowledge?.getDecisions !== "function" || typeof bus?.send !== "function") {
    throw new ConfigurationError("Architecture Manager requires decision, knowledge, roadmap, and communication services.");
  }

  return Object.freeze({ createArchitecturePlan, createRoadmap, createSprintBreakdown });

  function createArchitecturePlan(input) {
    const request = assertInput(input);
    const sourceDecisions = input.decisions ?? input.architecture_decisions ?? [];
    const stored = sourceDecisions.map((decision, index) => decisions.append(normalizeDecision(decision, request, index)));
    const plan = {
      project_id: request.project_id,
      decisions: stored,
      architecture: knowledge.getArchitecture(),
      standards: knowledge.getStandards(),
      constraints: knowledge.getConstraints()
    };
    publish(request.project_id, "governance.architecture_plan.created", plan, input.timestamp, input.request_id);
    return structuredClone(plan);
  }

  function createRoadmap(input) {
    const request = assertInput(input);
    const roadmap = normalizeRoadmap(input, request);
    const saved = roadmaps.save(roadmap);
    publish(request.project_id, "governance.roadmap.created", saved, input.timestamp, input.request_id);
    return structuredClone(saved);
  }

  function createSprintBreakdown(input) {
    const request = assertInput(input);
    const roadmapId = input.roadmap_id ?? `ROADMAP-${request.project_id}`;
    const sprints = (input.sprints ?? input.sprint_breakdown ?? []).map((sprint, index) => normalizeSprint(sprint, request, roadmapId, index));
    if (sprints.length === 0) throw new ConfigurationError("Sprint breakdown requires at least one sprint.");
    const breakdown = { project_id: request.project_id, roadmap_id: roadmapId, sprints };
    publish(request.project_id, "governance.sprint_breakdown.created", breakdown, input.timestamp, input.request_id);
    return structuredClone(breakdown);
  }

  function publish(projectId, messageType, payload, timestamp, requestId) {
    bus.send({
      id: `MSG-${messageType}-${projectId}${requestId ? `-${requestId}` : ""}`,
      project_id: projectId,
      sender: { id: managerId, role: "architecture_manager" },
      recipient: { id: nodeId, role: "node" },
      message_type: messageType,
      payload: structuredClone(payload),
      timestamp: timestamp ?? "2026-01-01T00:00:00Z"
    });
  }
}

function assertInput(input) {
  if (!input || typeof input !== "object" || typeof input.project_id !== "string" || input.project_id.length === 0) {
    throw new ConfigurationError("Architecture Manager input requires project_id.");
  }
  return input;
}

function normalizeDecision(decision, input, index) {
  const source = typeof decision === "string" ? { decision } : decision;
  return {
    id: source.id ?? `DECISION-${input.project_id}-${index + 1}`,
    project_id: input.project_id,
    type: source.type ?? "architecture",
    title: source.title ?? `Architecture Decision ${index + 1}`,
    decision: source.decision,
    ...(source.rationale ? { rationale: source.rationale } : {}),
    status: source.status ?? "proposed",
    created_at: source.created_at ?? input.created_at ?? "2026-01-01T00:00:00Z"
  };
}

function normalizeRoadmap(input, request) {
  const source = input.roadmap ?? input;
  const roadmap = {
    id: source.id ?? `ROADMAP-${request.project_id}`,
    project_id: request.project_id,
    version: source.version ?? "1.0.0",
    ...(source.architecture_decision_ids ? { architecture_decision_ids: [...source.architecture_decision_ids] } : {}),
    ...(source.goals ? { goals: [...source.goals] } : {}),
    sprints: (source.sprints ?? input.sprints ?? []).map((sprint, index) => normalizeSprint(sprint, request, source.id ?? `ROADMAP-${request.project_id}`, index)),
    created_at: source.created_at ?? input.created_at ?? "2026-01-01T00:00:00Z",
    ...(source.updated_at ? { updated_at: source.updated_at } : {})
  };
  if (roadmap.sprints.length === 0) throw new ConfigurationError("Roadmap requires at least one sprint.");
  return roadmap;
}

function normalizeSprint(sprint, input, roadmapId, index) {
  const source = sprint ?? {};
  const sprintId = source.id ?? `SPRINT-${input.project_id}-${index + 1}`;
  return {
    id: sprintId,
    roadmap_id: roadmapId,
    project_id: input.project_id,
    objective: source.objective ?? input.objective ?? `Sprint ${index + 1}`,
    ...(source.dependencies ? { dependencies: [...source.dependencies] } : {}),
    tickets: (source.tickets ?? []).map((ticket, ticketIndex) => ({
      id: ticket.id ?? `TICKET-${input.project_id}-${index + 1}-${ticketIndex + 1}`,
      project_id: input.project_id,
      roadmap_id: roadmapId,
      sprint_id: sprintId,
      title: ticket.title ?? `Ticket ${ticketIndex + 1}`,
      objective: ticket.objective ?? ticket.description ?? "Execute planned work.",
      acceptance_criteria: [...(ticket.acceptance_criteria ?? ["Implementation satisfies the planned objective."])],
      ...(ticket.priority ? { priority: ticket.priority } : {}),
      ...(ticket.dependencies ? { dependencies: [...ticket.dependencies] } : {}),
      provenance: ticket.provenance ?? { source: "sprint_plan", source_id: sprintId, created_at: input.created_at ?? "2026-01-01T00:00:00Z" }
    })),
    exit_criteria: [...(source.exit_criteria ?? input.exit_criteria ?? ["All planned tickets are complete."])]
  };
}
