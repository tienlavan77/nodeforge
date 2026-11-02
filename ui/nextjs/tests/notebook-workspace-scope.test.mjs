/**
 * Verifies the Notebook workspace scope boundaries across Architecture Manager (home),
 * System Engineer (system), and Coding workspaces. This test suite ensures that only the AM
 * home workspace exposes the Notebook dock button and panel, while System and Coding workspaces
 * omit Notebook without disrupting Watcher, Agent activity, or Coding agent monitor controls.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runBrowserVerification } from "../../../backend/src/modules/supervisor/browser/browser-verification-runner.js";
import { browserAssertions } from "./notebook-workspace-scope.browser.mjs";

const workspaceMonitorsSource = await readFile(new URL("../components/WorkspaceMonitorPanels.jsx", import.meta.url), "utf8");
const codingMonitorSource = await readFile(new URL("../components/coding-workspace-monitor.jsx", import.meta.url), "utf8");
const architectureWorkspaceSource = await readFile(new URL("../components/architecture-workspace.jsx", import.meta.url), "utf8");
const systemPageSource = await readFile(new URL("../app/system/page.jsx", import.meta.url), "utf8");

test("WorkspaceMonitorPanels restricts NotebookDock to layoutScope='home' while preserving System scope", () => {
  assert.match(workspaceMonitorsSource, /layoutScope\s*===\s*["']home["']\s*&&\s*<NotebookDock\b/);
  assert.match(architectureWorkspaceSource, /<WorkspaceMonitorPanels\b(?=[^>]*\blayoutScope=["']home["'])/);
  assert.match(systemPageSource, /<WorkspaceMonitorPanels\b(?=[^>]*\blayoutScope=["']system["'])/);
});

test("CodingWorkspaceMonitor does not import or render NotebookDock in its workspace monitor dock", () => {
  assert.doesNotMatch(codingMonitorSource, /\bNotebookDock\b/);
  assert.doesNotMatch(codingMonitorSource, /notebook-dock/);
  assert.doesNotMatch(codingMonitorSource, /Sổ tay/);
  assert.match(codingMonitorSource, /<div\b(?=[^>]*\bclassName=["']workspace-monitor-dock["'])/);
});

test("Notebook workspace scope approved Chromium scenarios at 375, 768 and 1440 pixels", { timeout: 90000 }, async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const receipt = await runBrowserVerification({
    projectRoot: root,
    sourceRoot: root,
    step: {
      kind: "browser",
      scenario_path: "ui/nextjs/tests/notebook-workspace-scope.browser.mjs",
      viewports: [375, 768, 1440],
      assertions: Object.keys(browserAssertions),
      criterion_ids: ["AC-1", "AC-2", "AC-3", "AC-4"]
    }
  });
  assert.ok(receipt);
});
