/**
 * Normalizes floating monitor window geometry and visibility state for the Architecture Manager
 * and System Engineer workspaces. This module enforces viewport bounds and backward-compatible
 * defaults from INITIAL_PANELS while ensuring only numeric geometry and boolean visibility/minimized
 * state are persisted to localStorage, preventing notebook or draft content from ever being saved.
 */

export const MONITOR_LAYOUT_KEY = "nodeforge:workspace-monitor-layout";

export const INITIAL_PANELS = {
  handoff: { x: 24, y: 120, width: 380, height: 520, visible: false, minimized: false },
  watcher: { x: 24, y: 24, width: 360, height: 260, visible: true, minimized: false },
  agent: { x: 410, y: 24, width: 360, height: 260, visible: true, minimized: false },
  notebook: { x: 16, y: 64, width: 340, height: 360, visible: false, minimized: false },
};

/**
 * Clamp one monitor panel's coordinates and dimensions so its floating window remains reachable
 * and completely within the active browser viewport across desktop, tablet, and mobile widths.
 */
export function clampMonitorPanel(panel, defaults = INITIAL_PANELS.notebook, viewportWidth = 1440, viewportHeight = 900) {
  const safeWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1440;
  const safeHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 900;
  const minW = Math.min(safeWidth <= 640 ? 220 : 260, Math.max(120, safeWidth - 16));
  const maxW = Math.max(minW, safeWidth - (safeWidth <= 640 ? 16 : 24));
  const minH = Math.min(120, Math.max(60, safeHeight - 24));
  const maxH = Math.max(minH, safeHeight - 24);
  const rawWidth = Number.isFinite(panel?.width) ? panel.width : defaults.width;
  const rawHeight = Number.isFinite(panel?.height) ? panel.height : defaults.height;
  const width = Math.max(minW, Math.min(rawWidth, maxW));
  const height = Math.max(minH, Math.min(rawHeight, maxH));
  const minimized = typeof panel?.minimized === "boolean" ? panel.minimized : defaults.minimized;
  const visible = typeof panel?.visible === "boolean" ? panel.visible : defaults.visible;
  const effectiveHeight = minimized ? 44 : height;
  const maxX = Math.max(0, safeWidth - width);
  const maxY = Math.max(0, safeHeight - effectiveHeight);
  const rawX = Number.isFinite(panel?.x) ? panel.x : defaults.x;
  const rawY = Number.isFinite(panel?.y) ? panel.y : defaults.y;
  const x = Math.max(0, Math.min(rawX, maxX));
  const y = Math.max(0, Math.min(rawY, maxY));
  return { x, y, width, height, visible, minimized };
}

/**
 * Constrain pointer drag movement for a floating monitor panel so the dragged window stays inside
 * the current browser viewport boundaries at all times.
 */
export function clampDraggedMonitorPosition(panel, nextX, nextY, viewportWidth = 1440, viewportHeight = 900) {
  const safeWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1440;
  const safeHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 900;
  const width = Math.min(Number.isFinite(panel?.width) ? panel.width : 340, safeWidth);
  const effectiveHeight = panel?.minimized ? 44 : Math.min(Number.isFinite(panel?.height) ? panel.height : 260, safeHeight);
  const maxX = Math.max(0, safeWidth - width);
  const maxY = Math.max(0, safeHeight - effectiveHeight);
  return {
    x: Math.max(0, Math.min(nextX, maxX)),
    y: Math.max(0, Math.min(nextY, maxY)),
  };
}

/**
 * Restore a saved workspace monitor layout record while filling missing panels or missing
 * individual fields from INITIAL_PANELS so older AM layout records remain backward-compatible.
 */
export function restoreMonitorLayout(saved, viewportWidth = 1440, viewportHeight = 900, basePanels = INITIAL_PANELS) {
  if (!saved || typeof saved !== "object") return basePanels;
  const safeWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1440;
  const safeHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 900;
  return Object.fromEntries(Object.entries(basePanels).map(([name, defaults]) => {
    const entry = saved[name] ?? (name === "notebook" ? saved.ideas : undefined);
    if (!entry || typeof entry !== "object") {
      return [name, name === "notebook" ? clampMonitorPanel(defaults, defaults, safeWidth, safeHeight) : defaults];
    }
    if (name === "notebook") {
      return [name, clampMonitorPanel(entry, defaults, safeWidth, safeHeight)];
    }
    return [name, {
      ...defaults,
      x: Number.isFinite(entry.x) ? Math.max(0, Math.min(entry.x, safeWidth - 100)) : defaults.x,
      y: Number.isFinite(entry.y) ? Math.max(0, Math.min(entry.y, safeHeight - 60)) : defaults.y,
      width: Number.isFinite(entry.width) ? Math.max(260, Math.min(entry.width, safeWidth - 24)) : defaults.width,
      height: Number.isFinite(entry.height) ? Math.max(120, Math.min(entry.height, safeHeight - 24)) : defaults.height,
      visible: typeof entry.visible === "boolean" ? entry.visible : defaults.visible,
      minimized: typeof entry.minimized === "boolean" ? entry.minimized : defaults.minimized,
    }];
  }));
}

/**
 * Serialize only the approved window geometry and visibility/minimized state fields for storage,
 * stripping any extraneous properties so notebook or draft text can never be written to localStorage.
 */
/**
 * Business purpose: Maintains the stacking order of floating workspace monitor panels so selecting or activating a panel brings it to the top above other panels.
 * Technical description: Moves the target panel name to the end of the ordered panel stack while preserving existing relative order for remaining panels.
 */
export function bringMonitorPanelToFront(order = ["watcher", "agent", "notebook"], name) {
  const base = Array.isArray(order) && order.length ? order : ["watcher", "agent", "notebook"];
  if (!name) return base;
  return [...base.filter((item) => item !== name), name];
}

/**
 * Business purpose: Computes the CSS z-index for a floating workspace monitor panel so the active panel renders above inactive panels while staying below the monitor dock.
 * Technical description: Returns a base stacking index plus the panel's position in the order stack and a top-level boost when the panel is currently active.
 */
export function getMonitorPanelZIndex(order = ["watcher", "agent", "notebook"], name, activePanel = null) {
  const list = Array.isArray(order) && order.length ? order : ["watcher", "agent", "notebook"];
  const index = Math.max(0, list.indexOf(name));
  return 82 + index + (activePanel === name ? 6 : 0);
}

export function serializeMonitorLayout(panels, layoutScope = "home") {
  const keys = layoutScope === "home" ? ["watcher", "agent", "handoff", "notebook"] : ["watcher", "agent"];
  const output = {};
  for (const name of keys) {
    const defaults = INITIAL_PANELS[name] ?? INITIAL_PANELS.watcher;
    const panel = panels?.[name] ?? defaults;
    output[name] = {
      x: Number.isFinite(panel.x) ? Math.round(panel.x) : defaults.x,
      y: Number.isFinite(panel.y) ? Math.round(panel.y) : defaults.y,
      width: Number.isFinite(panel.width) ? Math.round(panel.width) : defaults.width,
      height: Number.isFinite(panel.height) ? Math.round(panel.height) : defaults.height,
      visible: typeof panel.visible === "boolean" ? panel.visible : defaults.visible,
      minimized: typeof panel.minimized === "boolean" ? panel.minimized : defaults.minimized,
    };
  }
  return output;
}
