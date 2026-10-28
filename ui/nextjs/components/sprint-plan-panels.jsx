'use client';
// Manage sprint plans and their ticket execution controls.

import { useEffect, useRef, useState } from "react";
import { PanelHeader } from "./agent-panel-header.jsx";
import { EntityDetailsModal, TicketCard, sortSprintTickets } from "./ticket-detail-modal.jsx";
import { SprintTicketScope } from "./sprint-ticket-scope.js";
import { PlanReviewModal } from "./plan-review-modal.jsx";

import { PROJECT_ID } from "../lib/home-page-constants.js";

// Dashboard for viewing and managing sprint plans.
export function SprintPlanDashboard({ dashboard, client, onRefresh, onTicketDeleted, onSprintDeleted, hideHeading = false, defaultCollapsed = false }) {
  const [runningId, setRunningId] = useState(null);
  const [runMessage, setRunMessage] = useState("");
  const [runEvents, setRunEvents] = useState([]);
  const runStreamRef = useRef(null);
  const [viewSprint, setViewSprint] = useState(null);
  const [reviewSprint, setReviewSprint] = useState(null);
  const [viewState, setViewState] = useState("idle");
  const [deleteMessage, setDeleteMessage] = useState("");
  const [highlightSprint, setHighlightSprint] = useState(null);
  const [collapsedSprints, setCollapsedSprints] = useState({});
  const knownSprintIds = useRef(null);
  useEffect(() => () => runStreamRef.current?.close?.(), []);
  const sprints = dashboard?.roadmap?.sprints ?? [];
  useEffect(() => {
    const ids = new Set(sprints.map((sprint) => sprint.id));
    if (knownSprintIds.current) {
      const created = sprints.find((sprint) => !knownSprintIds.current.has(sprint.id));
      if (created) {
        setHighlightSprint(created.id);
        const highlightTimer = setTimeout(() => setHighlightSprint(null), 3000);
        knownSprintIds.current = ids;
        return () => clearTimeout(highlightTimer);
      }
    }
    knownSprintIds.current = ids;
  }, [sprints]);
  if (!sprints.length) return null;

  async function handleRun(sprintId) {
    if (runningId) return;
    setRunningId(sprintId);
    setRunMessage("");
    setRunEvents([]);
    try {
      const projectId = dashboard.project_id ?? PROJECT_ID;
      const tasks = sprints.find((sprint) => sprint.id === sprintId)?.tasks ?? [];
      const statuses = new Map(tasks.map((ticket) => [ticket.id, ticket.status]));
      runStreamRef.current?.close?.();
      runStreamRef.current = client.connectProjectStream({ projectId, onEvent: (event) => {
        if (event.event_type !== "ticket.status_changed" || !statuses.has(event.payload.ticket_id)) return;
        const { ticket_id: ticketId, status } = event.payload;
        statuses.set(ticketId, status);
        setRunEvents((events) => [...events.slice(-19), `${ticketId}: ${status}`]);
        if (["failed", "needs_human_review", "cancelled", "blocked"].includes(status)) {
          setRunningId(null); setRunMessage(`${ticketId}: ${status}.`);
        } else if ([...statuses.values()].every((value) => value === "done")) {
          setRunningId(null); setRunMessage(`Completed ${sprintId}.`);
        }
        void onRefresh?.();
      }, onError: () => setRunMessage("Run stream disconnected; refresh history for final result.") });
      const result = await client.runSprintPlan(projectId, sprintId);
      if (statuses.size && [...statuses.values()].every((value) => value === "done")) {
        setRunningId(null); setRunMessage(`Completed ${result.sprint_id}.`);
      } else setRunMessage(`Started ${result.sprint_id} — ${(result.levels ?? []).length} dependency levels.`);
    } catch (error) {
      const msg = String(error?.message ?? "");
      if (msg.toLowerCase().includes("already running")) {
        setRunMessage(`Sprint ${sprintId} is already running (409).`);
      } else {
        setRunMessage(`Run failed: ${msg}`);
      }
      runStreamRef.current?.close?.();
      setRunningId(null);
    }
  }

  async function handleView(sprintId) {
    setViewState("loading");
    setViewSprint(null);
    try { setViewSprint(await client.getSprintPlan(dashboard.project_id ?? PROJECT_ID, sprintId)); setViewState("ready"); }
    catch (error) { setViewState(error.message); }
  }
  async function handleDelete(sprintId) {
    const sprint = sprints.find((item) => item.id === sprintId);
    if (!window.confirm(`Remove ${sprintId} from active Sprints? Registry plans and history are retained.`)) return;
    try {
      const result = await client.deleteSprintPlan(dashboard.project_id ?? PROJECT_ID, sprintId, sprint?.version);
      setDeleteMessage(`${result.archived ? "Archived" : "Deleted"} ${sprintId}.`);
      if (onSprintDeleted) onSprintDeleted(sprintId);
      else await onRefresh?.();
    }
    catch (error) { setDeleteMessage(`Delete failed: ${error.message}`); }
  }

  return <section className="sprint-plan-dashboard" aria-label="Uploaded sprint plans">
    {!hideHeading && <h2>Roadmap Sprints</h2>}
    {sprints.map((sprint) => <article key={sprint.id} className={`sprint-item ${highlightSprint === sprint.id ? "is-new" : ""}`}>
      <div className="sprint-row"><div><strong>{sprint.id}</strong>{highlightSprint === sprint.id && <span className="sprint-new-badge">NEW</span>}</div><button className="sprint-collapse-button" onClick={() => setCollapsedSprints((state) => ({ ...state, [sprint.id]: !(state[sprint.id] ?? defaultCollapsed) }))} aria-label="Toggle sprint tasks" aria-expanded={!(collapsedSprints[sprint.id] ?? defaultCollapsed)}>{(collapsedSprints[sprint.id] ?? defaultCollapsed) ? "+" : "−"}</button></div>
      <p>{sprint.objective ?? "No sprint objective provided."}</p>
      <small>{sprint.tasks?.filter((task) => task.status === "done").length ?? 0}/{sprint.tasks?.length ?? 0} tasks completed · {sprint.status ?? "planned"}</small>
      {!(collapsedSprints[sprint.id] ?? defaultCollapsed) && <div className="sprint-ticket-list" aria-label={`Tasks in ${sprint.id}`}>
        {sprint.tasks?.length ? sortSprintTickets(sprint.tasks).map((ticket) => <TicketCard key={ticket.id} ticket={{ ...ticket, sprint_id: sprint.id }} client={client} projectId={dashboard.project_id} onRefresh={onRefresh} onDeleted={onTicketDeleted} />) : <p className="dashboard-state">No tasks in this sprint.</p>}
      </div>}
      {(sprint.decision_requests ?? []).length > 0 && <p>Quyết định cần duyệt: {sprint.decision_requests.length} · {sprint.plan_status === "approved" ? "Owner đã chốt" : "Chờ owner chọn phương án"}</p>}
      <div className="sprint-actions"><button className="sprint-view-button small" onClick={() => handleView(sprint.id)}>{viewSprint?.id === sprint.id && viewState === "ready" ? "Hide" : "View"}</button>{sprint.plan_id && sprint.plan_status === "awaiting_human_approval" && <button type="button" onClick={() => setReviewSprint(sprint.id)}>Review & approve</button>}<button className="sprint-delete-button small" onClick={() => handleDelete(sprint.id)} disabled={Boolean(runningId) || sprint.status === "done"}>Delete</button><button className={`sprint-run-button small ${runningId === sprint.id ? "is-running" : ""}`} onClick={() => handleRun(sprint.id)} disabled={Boolean(runningId) || sprint.status === "done" || sprint.plan_status === "awaiting_human_approval"}>{runningId === sprint.id ? "Running…" : "Run"}</button></div>
      {viewSprint?.id === sprint.id && <EntityDetailsModal title={viewSprint.id} state={viewState} onClose={() => { setViewState("idle"); setViewSprint(null); }}>{viewState === "ready" && <><p className="sprint-objective">{viewSprint.objective}</p><SprintTicketScope sprint={viewSprint} /><div className="sprint-ticket-table">{(viewSprint.tickets ?? []).map((ticket) => <article key={ticket.id}><strong>{ticket.id}</strong><span>{ticket.title}</span><small>{ticket.priority ?? "normal"}</small></article>)}</div><h3>Exit Criteria</h3><ul>{(viewSprint.exit_criteria ?? []).map((item) => <li key={item}>{item}</li>)}</ul></>}</EntityDetailsModal>}
    </article>)}
    {runMessage && <p className="sprint-run-message" role="status" aria-live="polite">{runMessage}</p>}
    {reviewSprint && <PlanReviewModal key={reviewSprint} client={client} projectId={dashboard.project_id ?? PROJECT_ID} sprintId={reviewSprint} onClose={() => setReviewSprint(null)} onChanged={async () => { setReviewSprint(null); await onRefresh?.(); }} />}
    {runEvents.length > 0 && <div className="sprint-run-events" role="log" aria-label="Sprint run events">{runEvents.map((event, index) => <div key={`${index}-${event}`}><strong>Run</strong> {event}</div>)}</div>}
    {deleteMessage && <p className="sprint-run-message" role="status">{deleteMessage}</p>}
  </section>;
}

// Panel rendering the project and sprint dashboard.
function ProjectDashboardPanel({ agent, dashboard, state, onActivate, active, onSettings, client, onRefresh }) {
  return <article className={`agent-panel dashboard-panel ${active ? "is-active" : ""}`} onClick={onActivate}>
    <PanelHeader agent={agent} onSettings={onSettings} />
    <div className="dashboard-content" aria-label="Project and Sprint Dashboard">
      {state === "loading" && <p className="dashboard-state">Loading dashboard from Node…</p>}
      {state === "error" && <p className="dashboard-state error">Node could not load the Project Dashboard.</p>}
      {state === "ready" && <DashboardData dashboard={dashboard} client={client} onRefresh={onRefresh} />}
    </div>
  </article>;
}

// Renders roadmap and sprint data inside the dashboard.
function DashboardData({ dashboard, client, onRefresh, onTicketDeleted }) {
  const sprints = dashboard?.roadmap?.sprints ?? [];
  if (!dashboard?.roadmap || !sprints.length) return <p className="dashboard-state">No roadmap or sprints have been published yet.</p>;
  return <>
    <div className="dashboard-overview"><span>ROADMAP <strong>{dashboard.roadmap.id}</strong></span><span>v{dashboard.roadmap.version}</span><span>{sprints.length} SPRINTS</span></div>
    {sprints.map((sprint) => <section className="dashboard-section" key={sprint.id}>
      <div className="sprint-row"><h3>{sprint.id}</h3><strong>{sprint.status ?? "planned"}</strong></div>
      <p>{sprint.objective ?? "No sprint objective provided."}</p>
      <small>{sprint.tasks?.filter((task) => task.status === "done").length ?? 0}/{sprint.tasks?.length ?? 0} tasks completed</small>
      {sprint.tasks?.length ? <div className="dashboard-tickets">{sprint.tasks.map((ticket) => <TicketCard key={ticket.id} ticket={{ ...ticket, sprint_id: sprint.id }} client={client} projectId={dashboard.project_id} onRefresh={onRefresh} onDeleted={onTicketDeleted} />)}</div> : <p className="dashboard-state">No tasks in this sprint.</p>}
    </section>)}
  </>;
}
