// Floating watcher and agent activity monitors for observing live NodeForge operations.
"use client";

import { useEffect, useRef, useState } from "react";

const MONITOR_LAYOUT_KEY = "nodeforge:workspace-monitor-layout";
const INITIAL_PANELS = {
  watcher: { x: 24, y: 24, width: 360, height: 260, visible: true, minimized: false },
  agent: { x: 410, y: 24, width: 360, height: 260, visible: true, minimized: false },
};

// Render movable, resizable monitor windows with close and restore controls.
export function WorkspaceMonitorPanels({ watcherEvents = [], watcherState = "connecting", agentProcess, agentActivities = [], layoutScope = "home" }) {
  const layoutKey = `${MONITOR_LAYOUT_KEY}:${layoutScope}`;
  const [panels, setPanels] = useState(INITIAL_PANELS);
  const [dragging, setDragging] = useState(null);
  const [layoutReady, setLayoutReady] = useState(false);
  const panelRefs = useRef({});

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(layoutKey) ?? "null");
      if (saved && typeof saved === "object") {
        setPanels((current) => Object.fromEntries(Object.entries(current).map(([name, defaults]) => {
          const entry = saved[name];
          if (!entry || typeof entry !== "object") return [name, defaults];
          return [name, {
            ...defaults,
            x: Number.isFinite(entry.x) ? Math.max(0, Math.min(entry.x, window.innerWidth - 100)) : defaults.x,
            y: Number.isFinite(entry.y) ? Math.max(0, Math.min(entry.y, window.innerHeight - 60)) : defaults.y,
            width: Number.isFinite(entry.width) ? Math.max(260, Math.min(entry.width, window.innerWidth - 24)) : defaults.width,
            height: Number.isFinite(entry.height) ? Math.max(120, Math.min(entry.height, window.innerHeight - 24)) : defaults.height,
            visible: typeof entry.visible === "boolean" ? entry.visible : defaults.visible,
            minimized: typeof entry.minimized === "boolean" ? entry.minimized : defaults.minimized,
          }];
        })));
      }
    } catch (error) {
      console.warn("Unable to restore workspace monitor layout", error);
    }
    setLayoutReady(true);
  }, [layoutKey]);

  useEffect(() => {
    if (!layoutReady) return undefined;
    const timeout = window.setTimeout(() => {
      try {
        window.localStorage.setItem(layoutKey, JSON.stringify(panels));
      } catch (error) {
        console.warn("Unable to save workspace monitor layout", error);
      }
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [layoutKey, layoutReady, panels]);

  useEffect(() => {
    if (!layoutReady || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => entries.forEach(({ target }) => {
      const name = target.dataset.monitorName;
      if (!name || panels[name].minimized) return;
      const { width, height } = target.getBoundingClientRect();
      setPanels((current) => current[name].width === width && current[name].height === height
        ? current
        : { ...current, [name]: { ...current[name], width, height } });
    }));
    Object.values(panelRefs.current).filter(Boolean).forEach((panel) => observer.observe(panel));
    return () => observer.disconnect();
  }, [layoutReady, panels.watcher.visible, panels.watcher.minimized, panels.agent.visible, panels.agent.minimized]);

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
    <div className="workspace-monitor-dock" role="group" aria-label="System monitors">
      {Object.entries(panels).map(([name, panel]) => <button key={name} type="button" aria-pressed={panel.visible && !panel.minimized} onClick={() => updatePanel(name, { visible: !panel.visible || panel.minimized, minimized: false })}>{name === "watcher" ? "Watcher" : "Agent activity"}</button>)}
    </div>
    <div className="workspace-monitor-layer" onPointerMove={movePanel} onPointerUp={() => setDragging(null)}>
      {panels.watcher.visible && <section ref={(node) => { panelRefs.current.watcher = node; }} data-monitor-name="watcher" className={`workspace-monitor${panels.watcher.minimized ? " is-minimized" : ""}`} style={{ left: panels.watcher.x, top: panels.watcher.y, width: panels.watcher.width, height: panels.watcher.minimized ? "auto" : panels.watcher.height }} aria-label="Watcher monitor">
        <header className="workspace-monitor-header" onPointerDown={(event) => startDrag(event, "watcher")}><strong>Watcher</strong><span className={`workspace-monitor-indicator is-${watcherState}`}>{watcherStatus}</span><button type="button" aria-label="Minimize Watcher monitor" onClick={() => updatePanel("watcher", { minimized: !panels.watcher.minimized })}>{panels.watcher.minimized ? "□" : "−"}</button><button type="button" aria-label="Close Watcher monitor" onClick={() => updatePanel("watcher", { visible: false })}>×</button></header>
        {!panels.watcher.minimized && <div className="workspace-monitor-content" aria-live="polite">
          {watcherEvents.length === 0 && <p>No recent watcher activity.</p>}
          {watcherEvents.slice().reverse().flatMap((event, eventIndex) => event.payload.activity.map((activity, activityIndex) => <article key={`${event.timestamp}-${eventIndex}-${activityIndex}`}><small>{event.event_type === "watcher.file_removed" ? "Removed" : "Indexed"}</small><span>{typeof activity === "string" ? activity : activity.path ?? activity.file_path ?? JSON.stringify(activity)}</span></article>))}
        </div>}
      </section>}
      {panels.agent.visible && <section ref={(node) => { panelRefs.current.agent = node; }} data-monitor-name="agent" className={`workspace-monitor${panels.agent.minimized ? " is-minimized" : ""}`} style={{ left: panels.agent.x, top: panels.agent.y, width: panels.agent.width, height: panels.agent.minimized ? "auto" : panels.agent.height }} aria-label="Agent activity monitor">
        <header className="workspace-monitor-header" onPointerDown={(event) => startDrag(event, "agent")}><strong>Agent activity</strong><span className="workspace-monitor-indicator">Live</span><button type="button" aria-label="Minimize Agent monitor" onClick={() => updatePanel("agent", { minimized: !panels.agent.minimized })}>{panels.agent.minimized ? "□" : "−"}</button><button type="button" aria-label="Close Agent monitor" onClick={() => updatePanel("agent", { visible: false })}>×</button></header>
        {!panels.agent.minimized && <div className="workspace-monitor-content" aria-live="polite">
          {processEntries.length === 0 && agentActivities.length === 0 && <p>Waiting for agent activity.</p>}
          {processEntries.map(([key, value]) => <article key={key}><small>{key.replaceAll("_", " ")}</small><span>{typeof value === "object" ? JSON.stringify(value) : String(value)}</span></article>)}
          {agentActivities.slice().reverse().map((event) => <article key={event.event_id}><small>{event.payload.activity_type.replaceAll("_", " ")} · {event.payload.status} · {new Date(event.timestamp).toLocaleTimeString()}</small><span>{event.payload.summary}{event.payload.tool_name ? ` (${event.payload.tool_name})` : ""}</span></article>)}
        </div>}
      </section>}
    </div>
  </>;
}
