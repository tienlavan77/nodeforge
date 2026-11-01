/**
 * Adds a notebook control to the existing workspace monitor dock without owning conversation state.
 * The selected project supplies an immutable client generation; opening the floating panel changes
 * only local visibility. Keeping the panel mounted preserves inputs during conversation or agent changes.
 */
"use client";
import { useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createNodeClient } from "../lib/node-client.js";
import { getProjectSelection, subscribeProjectSelection } from "../lib/project-selection.js";
// eslint-disable-next-line no-unused-vars -- The panel is rendered through JSX.
import { IdeasPanel } from "./ideas-panel.jsx";

/** Keep server rendering deterministic until the admitted client project snapshot becomes available. */
const initialSelection = { projectId: null, generation: 0 };

import {
  INITIAL_PANELS,
  clampDraggedMonitorPosition,
  clampMonitorPanel,
} from "../lib/workspace-monitor-layout.js";

/** Toggle the project notebook from the existing dock and restore keyboard focus when closing it. */
export function IdeasDock({ projectId: propProjectId, panelState, isActive = true, zIndex, onActivate, onUpdatePanel, onStartDrag, panelRef, renderPanel } = {}) {
  const selection = useSyncExternalStore(subscribeProjectSelection, getProjectSelection, () => initialSelection);
  const explicitProjectId = propProjectId && propProjectId !== selection.projectId ? propProjectId : undefined;
  const activeProjectId = explicitProjectId || selection.projectId;
  const client = useMemo(() => createNodeClient(explicitProjectId), [explicitProjectId, selection.projectId, selection.generation]);
  const [localPanel, setLocalPanel] = useState(() => clampMonitorPanel(INITIAL_PANELS.ideas, INITIAL_PANELS.ideas,
    typeof window !== "undefined" ? window.innerWidth : 1440,
    typeof window !== "undefined" ? window.innerHeight : 900));
  const draggingRef = useRef(null);
  const button = useRef(null);
  const panelId = useId();
  const controlled = Boolean(panelState && onUpdatePanel);
  const panel = controlled ? panelState : localPanel;
  const open = Boolean(panel.visible);
  const minimized = Boolean(panel.minimized);
  /**
   * Apply partial geometry or visibility updates to either the shared workspace monitor layout
   * state or the standalone local fallback state when IdeasDock is mounted outside AM monitors.
   */
  function update(changes) {
    if (controlled) onUpdatePanel(changes);
    else setLocalPanel((current) => ({ ...current, ...changes }));
  }
  /** Close only the notebook and reset minimized state; do not affect conversation navigation or stream subscriptions. */
  function close() { update({ visible: false, minimized: false }); button.current?.focus(); }
  /**
   * Toggle the floating Ideas monitor visibility from the dock control button, or expand it if
   * currently minimized, while keeping aria-pressed synchronized with whether the panel is open.
   */
  function toggleDock() { update({ visible: !open || minimized, minimized: false }); }
  /**
   * Toggle the minimized state of the Ideas floating monitor so the user can collapse or expand
   * the notebook body without losing in-memory drafts or closing the panel.
   */
  function toggleMinimize() { update({ minimized: !minimized }); }
  /**
   * Begin a pointer drag interaction from the Ideas monitor header unless the user clicked one
   * of the header's minimize or close control buttons, delegating to WorkspaceMonitorPanels when bound.
   */
  function handleHeaderPointerDown(event) {
    onActivate?.();
    if (event.target.closest("button")) return;
    event.preventDefault();
    if (onStartDrag) { onStartDrag(event); return; }
    draggingRef.current = { startX: event.clientX, startY: event.clientY, x: panel.x, y: panel.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  /**
   * Update the standalone Ideas floating monitor coordinates during an active pointer drag while
   * clamping the panel position so the window remains inside the active browser viewport.
   */
  function handlePointerMove(event) {
    const activeDrag = draggingRef.current;
    if (!activeDrag || onStartDrag) return;
    const next = clampDraggedMonitorPosition(
      panel,
      activeDrag.x + event.clientX - activeDrag.startX,
      activeDrag.y + event.clientY - activeDrag.startY,
      window.innerWidth,
      window.innerHeight
    );
    update(next);
  }
  if (!activeProjectId) return null;
  const style = {
    left: panel.x,
    top: panel.y,
    width: panel.width,
    height: minimized ? "auto" : panel.height,
    ...(Number.isFinite(zIndex) ? { zIndex } : {}),
  };
  const panelElement = <IdeasPanel
    key={activeProjectId}
    panelRef={panelRef}
    client={client}
    projectId={activeProjectId}
    open={open}
    minimized={minimized}
    isActive={isActive}
    onActivate={onActivate}
    onToggleMinimize={toggleMinimize}
    onClose={close}
    onHeaderPointerDown={handleHeaderPointerDown}
    style={style}
    panelId={panelId}
  />;
  return <>
    <button ref={button} type="button" aria-label="Ý tưởng" aria-pressed={open} aria-expanded={open && !minimized}
      aria-controls={panelId} onClick={toggleDock}>Ý tưởng</button>
    {renderPanel ? renderPanel(panelElement) : <div onPointerMove={handlePointerMove} onPointerUp={() => { draggingRef.current = null; }} onPointerCancel={() => { draggingRef.current = null; }}>{panelElement}</div>}
  </>;
}
