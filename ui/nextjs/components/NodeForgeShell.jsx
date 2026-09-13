"use client";

import Link from "next/link";
import { NodeForgeHeader } from "./NodeForgeHeader.jsx";
import { ArchitectureArtifacts, AgentSettingsOverlay, HistoryOverlay, InlineDecisionControls, Message, PanelHeader, SprintPlanDashboard, UploadSprintPlanDialog } from "./NodeForgePanels.jsx";

export function NodeForgeShell({ app }) {
  const { AGENTS, active, activeAgent, workingByAgent, drafts, historyChat, historyHasMore, historyLoading, conversationRefs, composerRef, wasAtBottomRef, setActiveAgent, setDrafts, historyOpen, setHistoryOpen, settingsAgent, setSettingsAgent, uploadOpen, setUploadOpen, send, handleScroll, dashboard, workspace, client, loadWorkspace, loadDashboard, architectureManagers, selectedArchitectureManagerId, setSelectedArchitectureManagerId } = app;
  const dashboardSprints = dashboard?.roadmap?.sprints ?? [];
  const dashboardTickets = dashboardSprints.flatMap((sprint) => sprint.tasks ?? []);
  const runningTickets = dashboardTickets.filter((ticket) => ticket.status === "running").length;
  const completedTickets = dashboardTickets.filter((ticket) => ticket.status === "done").length;
  const activeAgents = AGENTS.filter((agent) => workingByAgent[agent.id] === "WORKING").length;
  const status = <><span className="live-dot" /> node online <span className="status-separator">|</span> CPU 2.7% <span className="status-separator">|</span> RAM 182 MB</>;

  return <div className="app-shell app-shell-control-room">
    <NodeForgeHeader title="NODEFORGE" subtitle="Supervisor Control Room" status={status} actions={<><Link className="history-button" href="/agents">Agents</Link><button className="history-button" onClick={() => setUploadOpen(true)}>Upload Sprint Plan</button><button className="history-button" onClick={() => setHistoryOpen(true)}>History</button></>} />
    <section className="ops-strip" aria-label="Runtime summary">
      <div><span>Active agent</span><strong>{active.label}</strong></div>
      <div><span>Sprints</span><strong>{dashboardSprints.length}</strong></div>
      <div><span>Tickets</span><strong>{completedTickets}/{dashboardTickets.length}</strong></div>
      <div><span>Running</span><strong>{runningTickets + activeAgents}</strong></div>
    </section>
    <main className="workspace">
      <section className="chat-area panel" aria-label="Project Chat">
        <div className="project-chat-target">
          <label htmlFor="architecture-manager-selector">Architecture Manager</label>
          <select id="architecture-manager-selector" value={selectedArchitectureManagerId} onChange={(event) => setSelectedArchitectureManagerId(event.target.value)} aria-label="Architecture Manager selection">
            {!architectureManagers.length && <option value="">No enabled Architecture Manager agents available</option>}
            {architectureManagers.map((agent) => <option key={agent.id} value={agent.id}>{agent.label} ({agent.agent_id ?? agent.id})</option>)}
          </select>
        </div>
        <div className="tab-bar" role="tablist" aria-label="Agent tabs">
          {AGENTS.map((agent) => (
            <button key={agent.id} role="tab" aria-selected={activeAgent === agent.id} className={`tab-button ${activeAgent === agent.id ? "is-active" : ""} ${workingByAgent[agent.id] === "WORKING" ? "is-working" : ""}`} onClick={() => setActiveAgent(agent.id)} aria-label={`${agent.label} tab`}>
              <span className={`agent-avatar small ${agent.tone}`}>{agent.short}</span>
              <span className="tab-label">{agent.label}</span>
              {workingByAgent[agent.id] === "WORKING" && <span className="working-dot" aria-label="working" />}
            </button>
          ))}
        </div>
        <div style={{ display: "contents" }}>
          {AGENTS.map((agent) => {
            const isActive = activeAgent === agent.id;
            const working = workingByAgent[agent.id] === "WORKING";
            const rawChat = historyChat[agent.id] ?? [];
            const groups = [];
            const groupsByKey = new Map();
            for (const msg of rawChat) {
              const key = msg.dateKey ?? "";
              const label = msg.dateLabel ?? "Conversation";
              let group = groupsByKey.get(key);
              if (!group) {
                group = { key, label, messages: [] };
                groupsByKey.set(key, group);
                groups.push(group);
              }
              group.messages.push(msg);
            }
            const hasMore = historyHasMore[agent.id];
            const loading = historyLoading[agent.id];
            return <div key={agent.id} className="active-chat-panel" style={{ display: isActive ? "flex" : "none" }}>
              <PanelHeader agent={{ ...agent, status: workingByAgent[agent.id] }} onSettings={() => setSettingsAgent(agent)} />
              <div className="conversation natural-conversation" ref={(el) => { if (el) conversationRefs.current[agent.id] = el; }} onScroll={(e) => { const el = e.currentTarget; wasAtBottomRef.current[agent.id] = el.scrollHeight - el.scrollTop - el.clientHeight < 72; if (el.scrollTop <= 20) handleScroll(agent.id); }} role="log" aria-label={`${agent.label} messages`}>
                {groups.length === 0 && <div className="date-rule"><span>Conversation</span></div>}
                {loading && !rawChat.length && <p className="dashboard-state">Loading conversation…</p>}
                {hasMore && rawChat.length > 0 && <button className="history-more chat-load-more" onClick={() => handleScroll(agent.id)} disabled={loading}>{loading ? "Loading…" : "Load earlier messages"}</button>}
                {!hasMore && rawChat.length > 0 && <p className="dashboard-state" style={{ textAlign: "center" }}>Beginning of conversation</p>}
                {groups.map((group) => <div key={group.key || group.label} className="chat-date-group" data-date={group.key}>
                  <div className="date-rule"><span>{group.label || "Conversation"}</span></div>
                  {group.messages.map((message, index) => <Message key={message.id ?? `${agent.id}-${group.key}-${index}`} message={message} />)}
                </div>)}
                {working && <div className="working-status" role="status">{agent.label} is working…</div>}
              </div>
              {agent.id === "architecture-manager" && isActive && <InlineDecisionControls client={client} onWorkspaceChanged={loadWorkspace} workspace={workspace} />}
              <form className="composer" onSubmit={(event) => { event.preventDefault(); send(agent.id === "architecture-manager" ? (architectureManagers.some((candidate) => candidate.id === selectedArchitectureManagerId) ? selectedArchitectureManagerId : "") : agent.id); }}>
                <textarea ref={isActive ? composerRef : undefined} value={drafts[agent.id] ?? ""} onChange={(event) => setDrafts((current) => ({ ...current, [agent.id]: event.target.value }))} onInput={(event) => { event.currentTarget.style.height = "auto"; event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`; }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(agent.id === "architecture-manager" ? (architectureManagers.some((candidate) => candidate.id === selectedArchitectureManagerId) ? selectedArchitectureManagerId : "") : agent.id); } }} rows="2" placeholder={`Message ${agent.label}...`} aria-label={`Message ${agent.label}`} disabled={working || (agent.id === "architecture-manager" && !architectureManagers.some((candidate) => candidate.id === selectedArchitectureManagerId))} />
                <button type="submit" title="Send message" aria-label="Send message" disabled={working || (agent.id === "architecture-manager" && !architectureManagers.some((candidate) => candidate.id === selectedArchitectureManagerId))}>&#8593;</button>
              </form>
            </div>;
          })}
        </div>
      </section>
      <section className="info-panel panel" aria-label="Project info">
        <div className="info-artifacts">
          {workspace && <ArchitectureArtifacts workspace={workspace} />}
          <SprintPlanDashboard dashboard={dashboard} client={client} onRefresh={loadDashboard} />
        </div>
      </section>
    </main>
    <footer className="statusbar"><div><span className="status-key">ACTIVE CHANNEL</span><span className="status-value">{active.label}</span></div><div className="event-status"><span className="pulse" /> Event stream ready <span className="muted">/</span> session <strong>SPRINT-13</strong></div><div className="status-right">NODE v0.1.0</div></footer>
    {historyOpen && <HistoryOverlay client={client} onClose={() => setHistoryOpen(false)} />}
    {settingsAgent && <AgentSettingsOverlay client={client} agent={settingsAgent} onClose={() => setSettingsAgent(null)} />}
    {uploadOpen && <UploadSprintPlanDialog client={client} onClose={() => setUploadOpen(false)} onUploaded={loadDashboard} />}
  </div>;
}
