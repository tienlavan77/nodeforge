'use client';
// Manage sprint plans and their ticket execution controls.

import { useEffect, useRef, useState } from "react";
import { PanelHeader } from "./agent-panel-header.jsx";
import { EntityDetailsModal, TicketCard, sortSprintTickets } from "./ticket-detail-modal.jsx";

const PROJECT_ID = "PROJECT-NODEFORGE";

// Dashboard for viewing and managing sprint plans.
export function SprintPlanDashboard({ dashboard, client, onRefresh, onTicketDeleted, hideHeading = false }) {
  const [runningId, setRunningId] = useState(null);
  const [runMessage, setRunMessage] = useState("");
  const [runEvents, setRunEvents] = useState([]);
  const runStreamRef = useRef(null);
  const [viewSprint, setViewSprint] = useState(null);
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
    try {
      const projectId = dashboard.project_id ?? PROJECT_ID;
      const result = await client.runSprintPlan(projectId, sprintId);
      setRunMessage(`Started ${result.sprint_id} — session ${result.session_id}`);
      setRunEvents(["Run accepted; waiting for agent events…"]);
      runStreamRef.current?.close?.();
      const conversationId = `CONV-BUILDER-${sprintId}`;
      runStreamRef.current = client.connectConversationStream({ projectId, conversationId, onMessage: (message) => {
        const type = message.message_type ?? "";
        const value = message.payload?.text ?? message.payload?.error ?? type;
        setRunEvents((events) => [...events.slice(-19), value]);
        if (type.endsWith(".message.received") || type.endsWith(".error") || type === "agent.completed" || type === "agent.failed" || type === "verification.result") setRunningId(null);
        if (type.endsWith(".error")) setRunMessage(`Run failed: ${value}`);
      }, onError: () => setRunMessage("Run stream disconnected; refresh history for final result.") });
    } catch (error) {
      const msg = String(error?.message ?? "");
      if (error.status === 409 || msg.includes("409") || msg.toLowerCase().includes("already running")) {
        setRunMessage(`Sprint ${sprintId} is already running (409).`);
      } else {
        setRunMessage(`Run failed: ${msg}`);
      }
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
    if (!window.confirm(`Delete ${sprintId}? This removes file and database records.`)) return;
    try { await client.deleteSprintPlan(dashboard.project_id ?? PROJECT_ID, sprintId); setDeleteMessage(`Deleted ${sprintId}.`); }
    catch (error) { setDeleteMessage(`Delete failed: ${error.message}`); }
  }

  return <section className="sprint-plan-dashboard" aria-label="Uploaded sprint plans">
    {!hideHeading && <h2>Roadmap Sprints</h2>}
    {sprints.map((sprint) => <article key={sprint.id} className={`sprint-item ${highlightSprint === sprint.id ? "is-new" : ""}`}>
      <div className="sprint-row"><div><strong>{sprint.id}</strong>{highlightSprint === sprint.id && <span className="sprint-new-badge">NEW</span>}</div><button className="sprint-collapse-button" onClick={() => setCollapsedSprints((state) => ({ ...state, [sprint.id]: !state[sprint.id] }))} aria-label="Toggle sprint tasks">{collapsedSprints[sprint.id] ? "+" : "−"}</button></div>
      <p>{sprint.objective ?? "No sprint objective provided."}</p>
      <small>{sprint.tasks?.filter((task) => task.status === "done").length ?? 0}/{sprint.tasks?.length ?? 0} tasks completed · {sprint.status ?? "planned"}</small>
      {!collapsedSprints[sprint.id] && <InlineAddTicketForm sprint={sprint} projectId={dashboard.project_id ?? PROJECT_ID} client={client} onCreated={onRefresh} />}
      {!collapsedSprints[sprint.id] && <div className="sprint-ticket-list" aria-label={`Tasks in ${sprint.id}`}>
        {sprint.tasks?.length ? sortSprintTickets(sprint.tasks).map((ticket) => <TicketCard key={ticket.id} ticket={{ ...ticket, sprint_id: sprint.id }} client={client} projectId={dashboard.project_id} onRefresh={onRefresh} onDeleted={onTicketDeleted} />) : <p className="dashboard-state">No tasks in this sprint.</p>}
      </div>}
      <div className="sprint-actions"><button className="sprint-view-button small" onClick={() => handleView(sprint.id)}>{viewSprint?.id === sprint.id && viewState === "ready" ? "Hide" : "View"}</button><button className="sprint-delete-button small" onClick={() => handleDelete(sprint.id)} disabled={Boolean(runningId) || sprint.status === "done"}>Delete</button><button className={`sprint-run-button small ${runningId === sprint.id ? "is-running" : ""}`} onClick={() => handleRun(sprint.id)} disabled={Boolean(runningId) || sprint.status === "done"}>{runningId === sprint.id ? "Running…" : "Run"}</button></div>
      {viewSprint?.id === sprint.id && <EntityDetailsModal title={viewSprint.id} state={viewState} onClose={() => { setViewState("idle"); setViewSprint(null); }}>{viewState === "ready" && <><p className="sprint-objective">{viewSprint.objective}</p><h3>Tickets ({viewSprint.tickets?.length ?? 0})</h3><div className="sprint-ticket-table">{(viewSprint.tickets ?? []).map((ticket) => <article key={ticket.id}><strong>{ticket.id}</strong><span>{ticket.title}</span><small>{ticket.priority ?? "normal"}</small></article>)}</div><h3>Exit Criteria</h3><ul>{(viewSprint.exit_criteria ?? []).map((item) => <li key={item}>{item}</li>)}</ul></>}</EntityDetailsModal>}
    </article>)}
    {runMessage && <p className="sprint-run-message" role="status" aria-live="polite">{runMessage}</p>}
    {runEvents.length > 0 && <div className="sprint-run-events" role="log" aria-label="Sprint run events">{runEvents.map((event, index) => <div key={`${index}-${event}`}><strong>Run</strong> {event}</div>)}</div>}
    {deleteMessage && <p className="sprint-run-message" role="status">{deleteMessage}</p>}
  </section>;
}

// Inline form for adding a ticket to a sprint.
function InlineAddTicketForm({ sprint, projectId, client, onCreated }) {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [state, setState] = useState("");
  async function submit(event) {
    event.preventDefault();
    setError("");
    setState("Creating…");
    try { await client.createTicket(projectId, content, sprint.id); setContent(""); await onCreated?.(); }
    catch (failure) { setError(failure.message); }
    finally { setState(""); }
  }
  return <form className="inline-add-ticket" onSubmit={submit}>
    <label htmlFor={`add-ticket-${sprint.id}`}>Add a ticket to this sprint</label>
    <div className="inline-add-ticket-row">
      <textarea id={`add-ticket-${sprint.id}`} value={content} onChange={(event) => { setContent(event.target.value); setError(""); }} rows="2" placeholder="Describe the ticket in Vietnamese or paste a draft…" aria-label={`New ticket for ${sprint.id}`} />
      <button type="submit" disabled={!content.trim() || Boolean(state)}>{state ? "Adding…" : "Add ticket"}</button>
    </div>
    {error && <p className="inline-add-ticket-error" role="alert">{error}</p>}
  </form>;
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
