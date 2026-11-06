/**
 * Verifies workspace monitor layout persistence, viewport clamping, and backward-compatible
 * restoration for the Architecture Manager Notebook floating window alongside Watcher and Agent
 * activity monitors. Ensures legacy layout records missing Notebook or individual geometry/state
 * fields fall back safely to INITIAL_PANELS defaults, and that serialized storage records
 * contain only window geometry and visibility/minimized flags without leaking draft content.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  INITIAL_PANELS,
  MONITOR_LAYOUT_KEY,
  clampDraggedMonitorPosition,
  clampMonitorPanel,
  restoreMonitorLayout,
  serializeMonitorLayout,
} from "../lib/workspace-monitor-layout.js";

const workspaceMonitorsSource = await readFile(new URL("../components/WorkspaceMonitorPanels.jsx", import.meta.url), "utf8");
const notebookDockSource = await readFile(new URL("../components/notebook-dock.jsx", import.meta.url), "utf8");
const notebookPanelSource = await readFile(new URL("../components/notebook-panel.jsx", import.meta.url), "utf8");
const notebookStylesSource = await readFile(new URL("../app/styles/notebook-panel.css", import.meta.url), "utf8");

test("INITIAL_PANELS defines backward-compatible geometry and state defaults for watcher, agent, and notebook", () => {
  assert.equal(MONITOR_LAYOUT_KEY, "nodeforge:workspace-monitor-layout");
  assert.deepEqual(Object.keys(INITIAL_PANELS), ["handoff", "watcher", "agent", "notebook"]);
  assert.deepEqual(INITIAL_PANELS.watcher, { x: 24, y: 24, width: 360, height: 260, visible: true, minimized: false });
  assert.deepEqual(INITIAL_PANELS.agent, { x: 410, y: 24, width: 360, height: 260, visible: true, minimized: false });
  assert.deepEqual(INITIAL_PANELS.notebook, { x: 16, y: 64, width: 340, height: 360, visible: false, minimized: false });
});

test("legacy AM layout records without Notebook or with missing fields restore safely while preserving Watcher and Agent activity", () => {
  const legacySaved = {
    watcher: { x: 80, y: 90, width: 400, height: 300, visible: true, minimized: true },
    agent: { x: 500, y: 110, width: 420, height: 320, visible: false, minimized: false },
  };
  const restoredFromLegacy = restoreMonitorLayout(legacySaved, 1440, 900);
  assert.deepEqual(restoredFromLegacy.watcher, legacySaved.watcher);
  assert.deepEqual(restoredFromLegacy.agent, legacySaved.agent);
  assert.deepEqual(restoredFromLegacy.notebook, INITIAL_PANELS.notebook);

  const partialNotebookSaved = {
    watcher: { x: 40, y: 50 },
    agent: null,
    notebook: { x: 180, visible: true, width: "invalid", minimized: "nope" },
  };
  const restoredPartial = restoreMonitorLayout(partialNotebookSaved, 1440, 900);
  assert.equal(restoredPartial.watcher.x, 40);
  assert.equal(restoredPartial.watcher.y, 50);
  assert.equal(restoredPartial.watcher.width, INITIAL_PANELS.watcher.width);
  assert.equal(restoredPartial.watcher.height, INITIAL_PANELS.watcher.height);
  assert.deepEqual(restoredPartial.agent, INITIAL_PANELS.agent);
  assert.deepEqual(restoredPartial.notebook, {
    x: 180,
    y: INITIAL_PANELS.notebook.y,
    width: INITIAL_PANELS.notebook.width,
    height: INITIAL_PANELS.notebook.height,
    visible: true,
    minimized: false,
  });
});

test("clampMonitorPanel and clampDraggedMonitorPosition keep floating windows inside 375, 768, and 1440 viewports", () => {
  for (const viewport of [375, 768, 1440]) {
    const clamped = clampMonitorPanel({ x: 9999, y: 9999, width: 2000, height: 2000, visible: true, minimized: false }, INITIAL_PANELS.notebook, viewport, 800);
    assert.ok(clamped.x >= 0);
    assert.ok(clamped.y >= 0);
    assert.ok(clamped.x + clamped.width <= viewport);
    assert.ok(clamped.y + clamped.height <= 800);

    const dragged = clampDraggedMonitorPosition(clamped, -250, 5000, viewport, 800);
    assert.equal(dragged.x, 0);
    assert.ok(dragged.y >= 0 && dragged.y + clamped.height <= 800);
  }
});

test("serializeMonitorLayout persists only geometry and visibility/minimized state and strips draft or notebook content", () => {
  const dirtyPanels = {
    watcher: { ...INITIAL_PANELS.watcher, content: "secret-watcher" },
    agent: { ...INITIAL_PANELS.agent, draft: "secret-agent" },
    notebook: {
      x: 120.4,
      y: 88.6,
      width: 440.2,
      height: 360.8,
      visible: true,
      minimized: true,
      content: "SENTINEL_SECRET_NOTEBOOK",
      draft: { content: "SENTINEL_DRAFT", edit: { content: "SENTINEL_EDIT" } },
      items: [{ content: "SENTINEL_ITEM" }],
    },
    extra: { content: "SENTINEL_EXTRA" },
  };
  const serializedHome = serializeMonitorLayout(dirtyPanels, "home");
  const jsonHome = JSON.stringify(serializedHome);
  assert.doesNotMatch(jsonHome, /SENTINEL|secret/);
  assert.deepEqual(Object.keys(serializedHome), ["watcher", "agent", "handoff", "notebook"]);
  assert.deepEqual(serializedHome.notebook, {
    x: 120,
    y: 89,
    width: 440,
    height: 361,
    visible: true,
    minimized: true,
  });

  const serializedSystem = serializeMonitorLayout(dirtyPanels, "system");
  assert.deepEqual(Object.keys(serializedSystem), ["watcher", "agent"]);
});

test("Notebook panel and styles declare workspace-monitor-header, is-minimized, and resize: both when expanded", () => {
  assert.match(notebookPanelSource, /workspace-monitor-header/);
  assert.match(notebookPanelSource, /is-minimized/);
  assert.doesNotMatch(notebookPanelSource, /notebook-project|ideas-project/);
  assert.doesNotMatch(notebookPanelSource, /Project:\s*\{projectId\}/);
  assert.match(notebookStylesSource, /\.notebook-panel\s*\{[^}]*resize:\s*both/s);
  assert.match(notebookStylesSource, /\.notebook-panel\.is-minimized\s*\{[^}]*resize:\s*none/s);
  assert.match(workspaceMonitorsSource, /restoreMonitorLayout/);
  assert.match(workspaceMonitorsSource, /serializeMonitorLayout/);
});

test("Notebook styles declare approved textarea padding, inherited font, submit button alignment, and 26x26 centered header controls with hover", () => {
  const textareaBlock = notebookStylesSource.match(/\.notebook-panel\s+textarea\s*\{([^}]*)\}/s)?.[1] ?? "";
  assert.match(textareaBlock, /padding:\s*8px\s+10px/);
  assert.match(textareaBlock, /font(?:-family)?:\s*inherit/);

  const submitBlock = notebookStylesSource.match(/\.notebook-panel\s+\.notebook-entry-submit\s*\{([^}]*)\}/s)?.[1] ?? "";
  assert.match(submitBlock, /align-self:\s*flex-end/);
  assert.match(submitBlock, /width:\s*fit-content/);

  const headerBtnBlock = notebookStylesSource.match(/\.notebook-panel\s+\.workspace-monitor-header\s+button\s*\{([^}]*)\}/s)?.[1] ?? "";
  assert.match(headerBtnBlock, /width:\s*26px/);
  assert.match(headerBtnBlock, /height:\s*26px/);
  assert.match(headerBtnBlock, /display:\s*inline-flex/);
  assert.match(headerBtnBlock, /align-items:\s*center/);
  assert.match(headerBtnBlock, /justify-content:\s*center/);
  assert.match(headerBtnBlock, /padding:\s*0\b/);
  assert.match(headerBtnBlock, /line-height:\s*1\b/);
  assert.match(notebookStylesSource, /\.notebook-panel\s+\.workspace-monitor-header\s+button:hover/);
});

test("NotebookDock close and toggleDock reset minimized state and expand minimized panels from dock", () => {
  assert.match(notebookDockSource, /function\s+close\s*\(\)\s*\{[^}]*update\(\{\s*visible:\s*false\s*,\s*minimized:\s*false\s*\}\)/s);
  assert.match(notebookDockSource, /function\s+toggleDock\s*\(\)\s*\{[^}]*update\(\{\s*visible:\s*!open\s*\|\|\s*minimized\s*,\s*minimized:\s*false\s*\}\)/s);
});

test("NotebookPanel and styles implement 12px To-do list layout, split open/done lists, strikethrough checkbox items, right-side icon buttons, and drag-and-drop", () => {
  assert.match(notebookPanelSource, /data-notebook-list="open"/);
  assert.match(notebookPanelSource, /data-notebook-list="done"/);
  assert.match(notebookPanelSource, /type="checkbox"/);
  assert.match(notebookPanelSource, /aria-label="Sửa"/);
  assert.match(notebookPanelSource, /aria-label="Xóa"/);
  assert.match(notebookPanelSource, /draggable=\{dragEnabled\}/);
  assert.match(notebookStylesSource, /font-size:\s*12px\s*!important/);
  assert.match(notebookStylesSource, /text-decoration:\s*line-through/);
  assert.match(notebookStylesSource, /\.notebook-panel\s+\.notebook-todo-checkbox\s*\{[^}]*width:\s*12px;\s*height:\s*12px/s);
  assert.match(notebookStylesSource, /\.notebook-panel\s+\.notebook-icon-btn\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px/s);
  assert.match(notebookStylesSource, /\.notebook-panel\s+\.notebook-icon-btn\s+svg\s*\{[^}]*width:\s*8px;\s*height:\s*8px/s);
});

test("bringMonitorPanelToFront and getMonitorPanelZIndex promote the active panel to the top of the monitor stack", async () => {
  const { bringMonitorPanelToFront, getMonitorPanelZIndex } = await import("../lib/workspace-monitor-layout.js");
  const order1 = bringMonitorPanelToFront(["watcher", "agent", "notebook"], "watcher");
  assert.deepEqual(order1, ["agent", "notebook", "watcher"]);
  assert.ok(getMonitorPanelZIndex(order1, "watcher", "watcher") > getMonitorPanelZIndex(order1, "notebook", "watcher"));
  assert.ok(getMonitorPanelZIndex(order1, "watcher", "watcher") > getMonitorPanelZIndex(order1, "agent", "watcher"));

  const order2 = bringMonitorPanelToFront(order1, "notebook");
  assert.deepEqual(order2, ["agent", "watcher", "notebook"]);
  assert.ok(getMonitorPanelZIndex(order2, "notebook", "notebook") > getMonitorPanelZIndex(order2, "watcher", "notebook"));

  assert.match(workspaceMonitorsSource, /is-active-panel/);
  assert.match(workspaceMonitorsSource, /is-inactive-panel/);
  assert.match(workspaceMonitorsSource, /createPortal\(panelElement,\s*notebookPortalElement\)/);
  assert.match(workspaceMonitorsSource, /ref=\{setNotebookPortalElement\}\s+className="workspace-monitor-layer"/);
});
