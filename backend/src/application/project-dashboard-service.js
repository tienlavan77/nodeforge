import { ConfigurationError } from "../shared/errors.js";
import { getRegistryDashboard } from "./registry-dashboard.js";

// Read-only Node projection; canonical roadmap and provenance remain in governance modules.
export function createProjectDashboardService({ roadmaps, sprintPlans, provenance, ticketFileStore, ticketStatusStore, sprintRegistry, logReader, relevantTreeSelector } = {}) {
  if (typeof roadmaps?.getCurrent !== "function" || typeof sprintPlans?.getCurrentSprint !== "function"
    || typeof sprintPlans?.getSprintStatus !== "function" || typeof sprintPlans?.getSprintBacklog !== "function") {
    throw new ConfigurationError("Project Dashboard Service requires Roadmap and Sprint Plan projections.");
  }
  if (provenance !== undefined && typeof provenance?.validateProvenance !== "function") {
    throw new ConfigurationError("Project Dashboard provenance must provide validateProvenance().");
  }

  return Object.freeze({ getDashboard, getTicket, getTicketGraph });
  function findTicket(projectId, ticketId) {
    assertProjectId(projectId);
    if (typeof ticketId !== "string" || !ticketId) throw httpError(400, "A ticket id is required.");
    const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.project_id === projectId && item.id === ticketId)
      ?? (ticketFileStore?.getMetadata?.(ticketId)?.project_id === projectId ? ticketFileStore.readLatest(ticketId) : null);
    if (!ticket) throw httpError(404, `Ticket not found: ${ticketId}.`);
    return ticket;
  }
  function getTicket(projectId, ticketId) {
    const ticket = findTicket(projectId, ticketId);
    const metadata = ticketFileStore?.getMetadata?.(ticketId);
    return structuredClone({
      ...ticketView(ticket),
      // Owner context is intentionally exposed only by the ticket-detail API.
      // Dashboard lists and agent payloads remain canonical-English only.
      context: metadata?.project_id === projectId ? metadata.context : ""
    });
  }
  function getTicketGraph(projectId, ticketId) {
    if (!relevantTreeSelector?.select) throw new ConfigurationError("Ticket Code Graph API is not configured.");
    const ticket = findTicket(projectId, ticketId);
    return structuredClone({ project_id: projectId, ticket: ticketView(ticket), graph: relevantTreeSelector.select({ title: ticket.title, objective: ticket.objective, acceptance_criteria: ticket.acceptance_criteria ?? [], scope: "ui", allowed_prefixes: ["ui/nextjs/"] }) });
  }
  function getDashboard(projectId) {
    assertProjectId(projectId);
    const roadmap = roadmaps.getCurrent();
    if (typeof sprintRegistry?.listDetails === "function") return getRegistryDashboard({ projectId, sprintRegistry, roadmap, metadata: ticketFileStore?.listMetadata?.({ projectId }) ?? [], ticketStatusStore });
    if (roadmap && roadmap.project_id !== projectId) return emptyDashboard(projectId);
    const registry = sprintRegistry?.list?.() ?? [];
    const registered = new Map(registry.filter((entry) => entry.project_id === projectId).map((entry) => [entry.sprint_id, entry]));
    const projected = new Map((roadmap?.sprints ?? []).map((sprint) => [sprint.id, sprint]));
    const metadata = ticketFileStore?.listMetadata?.({ projectId }) ?? [];
    const sprintIds = [...new Set([...registered.keys(), ...projected.keys(), ...metadata.map((entry) => entry.sprint_id)])];
    if (!sprintIds.length) return emptyDashboard(projectId);
    const sprintEntries = sprintIds.map((sprintId, index) => {
      const sprint = projected.get(sprintId);
      const record = registered.get(sprintId);
      const status = sprint ? (sprintPlans.getSprintStatus(sprintId) ?? { status: "planned" }) : { status: "planned" };
      const sourceTasks = sprint?.tickets?.length ? sprint.tickets : (sprint ? (sprintPlans.getSprintBacklog(sprintId) ?? []) : []);
      const tickets = new Map(sourceTasks.filter((ticket) => ticket.project_id === projectId && ticket.sprint_id === sprintId).map((ticket) => [ticket.id, ticket]));
      for (const entry of metadata.filter((item) => item.sprint_id === sprintId)) {
        const ticket = ticketFileStore.readLatest(entry.id);
        if (ticket?.project_id !== projectId || ticket.sprint_id !== sprintId) throw httpError(409, `Ticket ownership differs from persisted metadata: ${entry.id}.`);
        tickets.set(entry.id, ticket);
      }
      const tasks = [...tickets.values()].map((ticket) => {
        const task = ticketView(ticket);
        const persisted = ticketStatusStore?.get?.(ticket.id);
        if (ticketStatusStore && !persisted) return { ...task, status: "untracked", progress: 0 };
        if (persisted?.project_id !== undefined && persisted.project_id !== projectId) throw httpError(409, `Ticket status ownership differs from project: ${ticket.id}.`);
        return persisted ? { ...task, status: persisted.status, progress: persisted.status === "done" ? 100 : ["running", "reviewing", "working"].includes(persisted.status) ? 50 : 0 } : task;
      });
      return { id: sprintId, objective: sprint?.objective ?? null, order: record?.position !== undefined ? record.position + 1 : index + 1, status: record?.status ?? status.status ?? "planned", tasks };
    });
    const build = (tasksBySprint = new Map()) => structuredClone({
      project_id: projectId,
      roadmap: { id: roadmap?.id ?? null, version: roadmap?.version ?? null, sprints: sprintEntries.map((sprint) => ({ ...sprint, tasks: (tasksBySprint.get(sprint.id) ?? sprint.tasks).map(taskViewSummary) })) }
    });
    if (!logReader || ticketStatusStore) return build();
    const allTasks = sprintEntries.flatMap((sprint) => sprint.tasks.map((task) => ({ sprintId: sprint.id, task })));
    return Promise.all(allTasks.map(async ({ sprintId, task }) => {
      try {
        const latest = (await logReader({ project_id: projectId, ticket_id: task.id }))?.events?.at(-1);
        if (!latest || task.status === "failed") return { sprintId, task };
        const status = latest.payload?.to ?? (/failed|error/i.test(latest.message ?? "") ? "failed" : /completed|done/i.test(latest.message ?? "") ? "done" : /running/i.test(latest.message ?? "") ? "running" : undefined);
        return { sprintId, task: status ? { ...task, status, progress: status === "done" ? 100 : status === "running" || status === "reviewing" ? 50 : 0 } : task };
      // eslint-disable-next-line no-silent-catch -- Dashboard degrades to the base task when log lookup fails.
      } catch { return { sprintId, task }; }
    })).then((items) => {
      const grouped = new Map(sprintEntries.map((sprint) => [sprint.id, []]));
      for (const item of items) grouped.get(item.sprintId)?.push(item.task);
      return build(grouped);
    });
  }
  function ticketView(ticket) {
    let chain;
    try {
      const value = provenance?.validateProvenance(ticket);
      chain = value ? {
        architecture_decision_ids: value.architecture_decisions.map(({ id }) => id),
        roadmap_id: value.roadmap.id,
        sprint_id: value.sprint.id
      } : undefined;
    // eslint-disable-next-line no-silent-catch -- Provenance is optional; dashboard renders without the chain.
    } catch {
      chain = undefined;
    }
    return {
      id: ticket.id,
      title: ticket.title,
      objective: ticket.objective,
      acceptance_criteria: ticket.acceptance_criteria ?? [],
      dependencies: ticket.dependencies ?? ticket.depends_on ?? [],
      project_id: ticket.project_id,
      roadmap_id: ticket.roadmap_id,
      priority: ticket.priority ?? "normal",
      status: ticket.status ?? "planned",
      progress: ticket.status === "done" ? 100 : ticket.status === "running" || ticket.status === "reviewing" ? 50 : 0,
      sprint_id: ticket.sprint_id,
      ...(ticket.owner ? { owner: ticket.owner } : {}),
      ...(ticket.commit_id ? { commit_id: ticket.commit_id } : {}),
      ...(chain ? { provenance: chain } : {})
    };
  }
}

// Maps a ticket to its dashboard summary view.
function taskViewSummary(task) { return { id: task.id, title: task.title, priority: task.priority, status: task.status, progress: task.progress }; }

// Returns an empty dashboard structure for a project.
function emptyDashboard(projectId, roadmap = null) {
  return { project_id: projectId, roadmap: roadmap ? { id: roadmap.id, version: roadmap.version, sprints: [] } : null };
}

// Creates an HTTP error with a status code.
function httpError(statusCode, message) { const error = new ConfigurationError(message); error.statusCode = statusCode; return error; }

// Validates that a project ID is a non-empty string.
function assertProjectId(projectId) {
  if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("A Project Dashboard project id is required.");
}
