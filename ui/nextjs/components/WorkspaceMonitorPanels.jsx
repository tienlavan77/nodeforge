// Floating watcher and agent activity monitors for observing live NodeForge operations.
"use client";

import { useState } from "react";

const INITIAL_PANELS = {
  watcher: { x: 24, y: 24, width: 360, height: 260, visible: true, minimized: false },
  agent: { x: 410, y: 24, width: 360, height: 260, visible: true, minimized: false },
};

// Render movable, resizable monitor windows with close and restore controls.
export function WorkspaceMonitorPanels({ watcherEvents = [], watcherState = "connecting", agentProcess }) {
  const [panels, setPanels] = useState(INITIAL_PANELS);
  const [dragging, setDragging] = useState(null);

  function updatePanel(name, changes) {
    setPanels((current) => ({ ...current, [name]: { ...current[name], ...changes } }));
  }

  function startDrag(event, name) {
    if (event.target.closest("button")) return;
    setDragging({ name, startX: event.clientX, startY: event.clientY, x: panels[name].x, y: panels[name].y });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function movePanel(event) {
    if (!dragging) return;
    updatePanel(dragging.name, {
      x: Math.max(0, dragging.x + event.clientX - dragging.startX),
      y: Math.max(0, dragging.y + event.clientY - dragging.startY),
    });
  }

  const watcherStatus = watcherState === "connected" ? "Connected" : watcherState === "error" ? "Error" : "Connecting";
  const processEntries = agentProcess && typeof agentProcess === "object" ? Object.entries(agentProcess) : [];

  return <>
    <div className="workspace-monitor-dock" aria-label="System monitors">
      {Object.entries(panels).filter(([, panel]) => !panel.visible).map(([name]) => <button key={name} type="button" onClick={() => updatePanel(name, { visible: true, minimized: false })}>{name === "watcher" ? "Watcher" : "Agent"}</button>)}
    </div>
    <div className="workspace-monitor-layer" onPointerMove={movePanel} onPointerUp={() => setDragging(null)}>
      {panels.watcher.visible && <section className={`workspace-monitor${panels.watcher.minimized ? " is-minimized" : ""}`} style={{ left: panels.watcher.x, top: panels.watcher.y, width: panels.watcher.width, height: panels.watcher.minimized ? "auto" : panels.watcher.height }} aria-label="Watcher monitor">
        <header className="workspace-monitor-header" onPointerDown={(event) => startDrag(event, "watcher")}><strong>Watcher</strong><span className={`workspace-monitor-indicator is-${watcherState}`}>{watcherStatus}</span><button type="button" aria-label="Minimize Watcher monitor" onClick={() => updatePanel("watcher", { minimized: !panels.watcher.minimized })}>{panels.watcher.minimized ? "□" : "−"}</button><button type="button" aria-label="Close Watcher monitor" onClick={() => updatePanel("watcher", { visible: false })}>×</button></header>
        {!panels.watcher.minimized && <div className="workspace-monitor-content" aria-live="polite">
          {watcherEvents.length === 0 && <p>No recent watcher activity.</p>}
          {watcherEvents.slice().reverse().flatMap((event, eventIndex) => event.payload.activity.map((activity, activityIndex) => <article key={`${event.timestamp}-${eventIndex}-${activityIndex}`}><small>{event.event_type === "watcher.file_removed" ? "Removed" : "Indexed"}</small><span>{typeof activity === "string" ? activity : activity.path ?? activity.file_path ?? JSON.stringify(activity)}</span></article>))}
        </div>}
      </section>}
      {panels.agent.visible && <section className={`workspace-monitor${panels.agent.minimized ? " is-minimized" : ""}`} style={{ left: panels.agent.x, top: panels.agent.y, width: panels.agent.width, height: panels.agent.minimized ? "auto" : panels.agent.height }} aria-label="Agent activity monitor">
        <header className="workspace-monitor-header" onPointerDown={(event) => startDrag(event, "agent")}><strong>Agent activity</strong><span className="workspace-monitor-indicator">Live</span><button type="button" aria-label="Minimize Agent monitor" onClick={() => updatePanel("agent", { minimized: !panels.agent.minimized })}>{panels.agent.minimized ? "□" : "−"}</button><button type="button" aria-label="Close Agent monitor" onClick={() => updatePanel("agent", { visible: false })}>×</button></header>
        {!panels.agent.minimized && <div className="workspace-monitor-content" aria-live="polite">
          {processEntries.length === 0 && <p>Waiting for agent activity.</p>}
          {processEntries.map(([key, value]) => <article key={key}><small>{key.replaceAll("_", " ")}</small><span>{typeof value === "object" ? JSON.stringify(value) : String(value)}</span></article>)}
        </div>}
      </section>}
    </div>
  </>;
}
