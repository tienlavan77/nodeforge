// Floating watcher and agent activity monitors for observing live NodeForge operations.
"use client";
// eslint-disable-next-line no-unused-vars -- The notebook control is rendered through JSX.
import { NotebookDock } from "./notebook-dock.jsx";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { monitorAgentActivities } from "../lib/monitor-agent-activities.js";
import {
  INITIAL_PANELS,
  MONITOR_LAYOUT_KEY,
  bringMonitorPanelToFront,
  clampDraggedMonitorPosition,
  getMonitorPanelZIndex,
  restoreMonitorLayout,
  serializeMonitorLayout,
} from "../lib/workspace-monitor-layout.js";

// Render movable, resizable monitor windows with close and restore controls.
export function WorkspaceMonitorPanels({ watcherEvents = [], watcherState = "connecting", agentProcess, agentActivities = [], agentDirectory = [], layoutScope = "home", activityRoles, selectedAgentId }) {
  const layoutKey = `${MONITOR_LAYOUT_KEY}:${layoutScope}`;
  const [panels, setPanels] = useState(INITIAL_PANELS);
  const draggingRef = useRef(null);
  const [layoutReady, setLayoutReady] = useState(false);
  const panelRefs = useRef({});
  const [watcherActive, setWatcherActive] = useState(false);
  const [agentActive, setAgentActive] = useState(false);
  const [notebookPortalElement, setNotebookPortalElement] = useState(null);
  const [activePanel, setActivePanel] = useState("agent");
  const [panelOrder, setPanelOrder] = useState(["watcher", "agent", "notebook"]);

  /**
   * Business purpose: Marks a workspace monitor panel as the active selection and promotes it to the top of the floating window stack.
   * Technical description: Updates activePanel state and moves the panel identifier to the end of panelOrder for z-index calculation.
   */
  function activatePanel(name) {
    if (!name) return;
    setActivePanel(name);
    setPanelOrder((current) => bringMonitorPanelToFront(current, name));
  }

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(layoutKey) ?? "null");
      setPanels((current) => restoreMonitorLayout(saved, window.innerWidth, window.innerHeight, current));
    } catch (error) {
      console.warn("Unable to restore workspace monitor layout", error);
    }
    setLayoutReady(true);
  }, [layoutKey]);

  useEffect(() => {
    if (!layoutReady) return undefined;
    try {
      window.localStorage.setItem(layoutKey, JSON.stringify(serializeMonitorLayout(panels, layoutScope)));
    } catch (error) {
      console.warn("Unable to save workspace monitor layout", error);
    }
    return undefined;
  }, [layoutKey, layoutReady, layoutScope, panels]);

  useEffect(() => {
    if (!layoutReady || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => entries.forEach(({ target }) => {
      const name = target.dataset.monitorName;
      if (!name || !panels[name] || panels[name].minimized || !panels[name].visible) return;
      const { width, height } = target.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const roundedW = Math.round(width);
      const roundedH = Math.round(height);
      setPanels((current) => current[name].width === roundedW && current[name].height === roundedH
        ? current
        : { ...current, [name]: { ...current[name], width: roundedW, height: roundedH } });
    }));
    Object.values(panelRefs.current).filter(Boolean).forEach((panel) => observer.observe(panel));
    return () => observer.disconnect();
  }, [
    layoutReady,
    panels.watcher.visible,
    panels.watcher.minimized,
    panels.agent.visible,
    panels.agent.minimized,
    panels.notebook?.visible,
    panels.notebook?.minimized,
  ]);

  function updatePanel(name, changes) {
    if (changes.visible === true) activatePanel(name);
    setPanels((current) => {
      const nextPanel = { ...current[name], ...changes };
      const next = { ...current, [name]: nextPanel };
      if (changes.visible === false) {
        setActivePanel((currentActive) => {
          if (currentActive !== name) return currentActive;
          const remaining = panelOrder.filter((key) => key !== name && next[key]?.visible);
          return remaining.at(-1) ?? null;
        });
      }
      return next;
    });
  }

  function startDrag(event, name) {
    activatePanel(name);
    if (event.target.closest("button")) return;
    event.preventDefault();
    draggingRef.current = { name, startX: event.clientX, startY: event.clientY, x: panels[name].x, y: panels[name].y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function movePanel(event) {
    const activeDrag = draggingRef.current;
    if (!activeDrag) return;
    const currentPanel = panels[activeDrag.name];
    const next = clampDraggedMonitorPosition(
      currentPanel,
      activeDrag.x + event.clientX - activeDrag.startX,
      activeDrag.y + event.clientY - activeDrag.startY,
      window.innerWidth,
      window.innerHeight
    );
    updatePanel(activeDrag.name, next);
  }

  const watcherStatus = watcherState === "connected" ? "Connected" : watcherState === "error" ? "Error" : "Connecting";
  const processEntries = agentProcess && typeof agentProcess === "object" ? Object.entries(agentProcess) : [];
  const visibleActivities = monitorAgentActivities(agentActivities, agentDirectory, activityRoles ?? (layoutScope === "home" ? "architecture_manager" : "system_engineer"), selectedAgentId);
  const latestWatcherEvent = watcherEvents.at(-1);
  const latestAgentEvent = visibleActivities.at(-1);

  useEffect(() => {
    if (watcherState !== "connected" || !latestWatcherEvent || Date.now() - Date.parse(latestWatcherEvent.timestamp) > 3000) { setWatcherActive(false); return undefined; }
    setWatcherActive(true);
    const timeout = window.setTimeout(() => setWatcherActive(false), 3000);
    return () => window.clearTimeout(timeout);
  }, [watcherState, latestWatcherEvent]);

  useEffect(() => {
    if (!latestAgentEvent || Date.now() - Date.parse(latestAgentEvent.timestamp) > 3000) { setAgentActive(false); return undefined; }
    setAgentActive(true);
    const timeout = window.setTimeout(() => setAgentActive(false), 3000);
    return () => window.clearTimeout(timeout);
  }, [latestAgentEvent]);

  return <div onPointerMove={movePanel} onPointerUp={() => { draggingRef.current = null; }} onPointerCancel={() => { draggingRef.current = null; }}>
    <div className="workspace-monitor-dock" role="group" aria-label="System monitors">
      {layoutScope === "home" && <NotebookDock
        panelState={panels.notebook}
        isActive={activePanel === "notebook"}
        zIndex={getMonitorPanelZIndex(panelOrder, "notebook", activePanel)}
        onActivate={() => activatePanel("notebook")}
        onUpdatePanel={(changes) => updatePanel("notebook", changes)}
        onStartDrag={(event) => startDrag(event, "notebook")}
        panelRef={(node) => { panelRefs.current.notebook = node; }}
        renderPanel={(panelElement) => (notebookPortalElement ? createPortal(panelElement, notebookPortalElement) : panelElement)}
      />}
      {["watcher", "agent"].map((name) => {
        const panel = panels[name];
        return <button key={name} type="button" aria-pressed={panel.visible && !panel.minimized} onClick={() => updatePanel(name, { visible: !panel.visible || panel.minimized, minimized: false })}><span className={`workspace-monitor-light${(name === "watcher" ? watcherActive : agentActive) ? " is-active" : name === "watcher" && watcherState !== "connected" ? " is-offline" : ""}`} aria-hidden="true" />{name === "watcher" ? "Watcher" : "Agent activity"}</button>;
      })}
    </div>
    <div ref={setNotebookPortalElement} className="workspace-monitor-layer">
      {panels.watcher.visible && <section ref={(node) => { panelRefs.current.watcher = node; }} data-monitor-name="watcher" data-monitor-active={activePanel === "watcher" ? "true" : "false"} onPointerDown={() => activatePanel("watcher")} onFocusCapture={() => activatePanel("watcher")} className={`workspace-monitor${panels.watcher.minimized ? " is-minimized" : ""}${activePanel === "watcher" ? " is-active-panel" : " is-inactive-panel"}`} style={{ left: panels.watcher.x, top: panels.watcher.y, width: panels.watcher.width, height: panels.watcher.minimized ? "auto" : panels.watcher.height, zIndex: getMonitorPanelZIndex(panelOrder, "watcher", activePanel) }} aria-label="Watcher monitor">
        <header className="workspace-monitor-header" onPointerDown={(event) => startDrag(event, "watcher")}><span className={`workspace-monitor-light${watcherActive ? " is-active" : watcherState !== "connected" ? " is-offline" : ""}`} aria-label={watcherActive ? "Watcher working" : "Watcher idle"} role="img" /><strong>Watcher</strong><span className={`workspace-monitor-indicator is-${watcherState}`}>{watcherStatus}</span><button type="button" aria-label="Minimize Watcher monitor" onClick={() => updatePanel("watcher", { minimized: !panels.watcher.minimized })}>{panels.watcher.minimized ? "□" : "−"}</button><button type="button" aria-label="Close Watcher monitor" onClick={() => updatePanel("watcher", { visible: false })}>×</button></header>
        {!panels.watcher.minimized && <div className="workspace-monitor-content" aria-live="polite">
          {watcherEvents.length === 0 && <p>No recent watcher activity.</p>}
          {watcherEvents.slice().reverse().flatMap((event, eventIndex) => event.payload.activity.map((activity, activityIndex) => <article key={`${event.timestamp}-${eventIndex}-${activityIndex}`}><small>{event.event_type === "watcher.file_removed" ? "Removed" : "Indexed"}</small><span>{typeof activity === "string" ? activity : activity.path ?? activity.file_path ?? JSON.stringify(activity)}</span></article>))}
        </div>}
      </section>}
      {panels.agent.visible && <section ref={(node) => { panelRefs.current.agent = node; }} data-monitor-name="agent" data-monitor-active={activePanel === "agent" ? "true" : "false"} onPointerDown={() => activatePanel("agent")} onFocusCapture={() => activatePanel("agent")} className={`workspace-monitor${panels.agent.minimized ? " is-minimized" : ""}${activePanel === "agent" ? " is-active-panel" : " is-inactive-panel"}`} style={{ left: panels.agent.x, top: panels.agent.y, width: panels.agent.width, height: panels.agent.minimized ? "auto" : panels.agent.height, zIndex: getMonitorPanelZIndex(panelOrder, "agent", activePanel) }} aria-label="Agent activity monitor">
        <header className="workspace-monitor-header" onPointerDown={(event) => startDrag(event, "agent")}><span className={`workspace-monitor-light${agentActive ? " is-active" : ""}`} aria-label={agentActive ? "Agent working" : "Agent idle"} role="img" /><strong>Agent activity</strong><span className={`workspace-monitor-indicator is-${watcherState}`}>{watcherStatus}</span><button type="button" aria-label="Minimize Agent monitor" onClick={() => updatePanel("agent", { minimized: !panels.agent.minimized })}>{panels.agent.minimized ? "□" : "−"}</button><button type="button" aria-label="Close Agent monitor" onClick={() => updatePanel("agent", { visible: false })}>×</button></header>
        {!panels.agent.minimized && <div className="workspace-monitor-content" aria-live="polite">
          {processEntries.length === 0 && visibleActivities.length === 0 && <p>Waiting for agent activity.</p>}
          {processEntries.map(([key, value]) => <article key={key}><small>{key.replaceAll("_", " ")}</small><span>{typeof value === "object" ? JSON.stringify(value) : String(value)}</span></article>)}
          {visibleActivities.slice().reverse().map((event) => <article key={event.event_id}><small>{event.payload.activity_type.replaceAll("_", " ")} · {event.payload.status} · {new Date(event.timestamp).toLocaleTimeString()}</small><span>{event.payload.summary}{event.payload.tool_name ? ` (${event.payload.tool_name})` : ""}</span></article>)}
        </div>}
      </section>}
    </div>
  </div>;
}
