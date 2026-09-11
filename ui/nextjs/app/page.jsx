"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { NodeForgeHeader } from "../components/NodeForgeHeader.jsx";
import { SprintPlanDashboard, UploadSprintPlanDialog } from "../components/NodeForgePanels.jsx";
import { createNodeClient } from "../lib/node-client.js";

const PROJECT_ID = "PROJECT-NODEFORGE";
const SPRINT_CACHE_KEY = `nodeforge:sprints:${PROJECT_ID}`;

function toDashboard(sprintPlans) {
  const plans = Array.isArray(sprintPlans) ? sprintPlans : sprintPlans?.items ?? sprintPlans?.sprints ?? [];
  return { project_id: PROJECT_ID, roadmap: { id: plans[0]?.roadmap_id ?? `ROADMAP-${PROJECT_ID}`, version: plans.at(-1)?.id ?? "latest", sprints: plans.map((sprint, index) => ({ id: sprint.id, objective: sprint.objective, order: index + 1, status: sprint.status ?? "planned", tasks: (sprint.tickets ?? []).map((ticket) => ({ ...ticket, status: ticket.status ?? "planned", progress: ticket.status === "done" ? 100 : ticket.status === "running" || ticket.status === "reviewing" ? 50 : 0 })) })) } };
}

function readSprintCache() {
  if (typeof window === "undefined") return null;
  try { return toDashboard(JSON.parse(window.sessionStorage.getItem(SPRINT_CACHE_KEY) ?? "null")); } catch { return null; }
}

export default function HomePage() {
  const client = useMemo(() => createNodeClient(), []);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [dashboardState, setDashboardState] = useState("loading");
  const [uploadOpen, setUploadOpen] = useState(false);

  async function loadDashboard() {
    try {
      const sprintPlans = await client.listSprints(PROJECT_ID);
      const nextDashboard = toDashboard(sprintPlans);
      setDashboard(nextDashboard);
      try { window.sessionStorage.setItem(SPRINT_CACHE_KEY, JSON.stringify(sprintPlans)); } catch { /* cache is optional */ }
      setDashboardState("ready");
    } catch {
      setDashboardState("error");
    }
  }

  useEffect(() => {
    const cached = readSprintCache();
    if (cached) {
      setDashboard(cached);
      setDashboardState("ready");
    }
    loadDashboard();
  }, []);

  function sendMessage(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setMessages((current) => [...current, { id: Date.now(), text }]);
    setDraft("");
  }

  function handleTicketDeleted(ticketId) {
    setDashboard((current) => {
      if (!current) return current;
      const next = { ...current, roadmap: { ...current.roadmap, sprints: current.roadmap.sprints.map((sprint) => ({ ...sprint, tasks: (sprint.tasks ?? []).filter((ticket) => ticket.id !== ticketId) })) } };
      try { window.sessionStorage.setItem(SPRINT_CACHE_KEY, JSON.stringify(next.roadmap.sprints.map((sprint) => ({ ...sprint, tickets: sprint.tasks })))); } catch { /* cache is optional */ }
      return next;
    });
  }

  const sprints = dashboard?.roadmap?.sprints ?? [];
  const tickets = sprints.flatMap((sprint) => sprint.tasks ?? []);
  const completed = tickets.filter((ticket) => ticket.status === "done").length;
  const latestSprint = sprints.at(-1);

  return <div className="app-shell app-shell-control-room home-workspace-shell">
    <NodeForgeHeader title="NODEFORGE" subtitle="Supervisor Control Room" status={<><span className="live-dot" /> node online</>} actions={<Link className="history-button" href="/agents">Agents</Link>} />
    <main className="home-workspace" aria-label="NodeForge workspace">
      <section className="home-chat-panel home-panel" aria-label="Project chat">
        <div className="home-panel-heading"><div><p className="eyebrow">PROJECT CHAT</p><h1>Talk to NodeForge</h1></div><span className="home-panel-badge">LIVE</span></div>
        <div className="home-chat-messages" role="log" aria-live="polite">{messages.length === 0 && <div className="home-empty-state"><span className="home-empty-mark">N</span><p>Send a message to start working with your project agents.</p></div>}{messages.map((message) => <div className="home-chat-message" key={message.id}><span className="home-message-avatar">You</span><p>{message.text}</p></div>)}</div>
        <form className="home-composer" onSubmit={sendMessage}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Describe what you want to build..." rows="2" aria-label="Message NodeForge" /><button type="submit" aria-label="Send message" disabled={!draft.trim()}>&#8593;</button></form>
      </section>
      <section className="home-sprint-panel home-panel" aria-label="Project sprints">
        <div className="home-panel-heading"><div><p className="eyebrow">PROJECT DELIVERY</p><h2>Sprints</h2></div><button className="history-button" type="button" onClick={() => setUploadOpen(true)}>Upload plan</button></div>
        {dashboardState === "loading" && <p className="dashboard-state">Loading sprint data...</p>}
        {dashboardState === "error" && <p className="dashboard-state error">Could not load sprint data.</p>}
        {dashboardState === "ready" && <div className="home-sprint-content">
          <SprintPlanDashboard dashboard={dashboard} client={client} onRefresh={loadDashboard} onTicketDeleted={handleTicketDeleted} hideHeading />
        </div>}
      </section>
      <section className="home-open-panel" aria-label="Workspace extension"><span>WORKSPACE</span><p>{dashboard?.roadmap?.id ?? "Project workspace"}</p><small>{sprints.length ? `${sprints.length} sprint${sprints.length === 1 ? "" : "s"} connected` : "No roadmap published yet."}</small></section>
    </main>
    {uploadOpen && <UploadSprintPlanDialog client={client} onClose={() => setUploadOpen(false)} onUploaded={() => { setUploadOpen(false); loadDashboard(); }} />}
  </div>;
}
