/**
 * Browser verification scenario for restricting the Notebook to the Architecture Manager
 * workspace. Bundles the real ProjectWorkspace, ArchitectureWorkspace, SystemPage, and CodingPage
 * components from sourceRoot so Chromium assertions exercise live workspace switching, dock
 * rendering, Notebook panel lifecycle, and Watcher/Agent/Coding monitor controls across viewports.
 */
import assert from "node:assert/strict";
import { join } from "node:path";

/**
 * Compiles the production Next.js workspace surfaces into a self-contained browser bundle with
 * deterministic fetch and EventSource stubs so each workspace scope can be inspected in Chromium.
 */
export async function createBrowserFixture({ sourceRoot, build }) {
  const source = [
    'import React, { useState } from "react";',
    'import { createRoot } from "react-dom/client";',
    'import ArchitectureWorkspace from "./components/architecture-workspace.jsx";',
    'import SystemPage from "./app/system/page.jsx";',
    'import CodingPage from "./app/coding/page.jsx";',
    'import { ProjectWorkspace } from "./components/project-workspace.jsx";',
    'import "./app/globals.css";',
    'window.calls = []; window.sources = []; localStorage.clear(); sessionStorage.clear();',
    'const agents = [',
    '  { agent_id: "AM-1", agent_name: "Arch Lead", role: "architecture_manager", enabled: true, project_id: "PROJECT-A" },',
    '  { agent_id: "SE-1", agent_name: "Sys Eng", role: "system_engineer", enabled: true, project_id: "PROJECT-A" },',
    '  { agent_id: "CODER-1", agent_name: "Alpha Coder", role: "coder", enabled: true, project_id: "PROJECT-A", status: "working" }',
    '];',
    'window.fetch = async (input, init = {}) => {',
    '  const url = new URL(input, location.origin), method = init.method || "GET", body = init.body ? JSON.parse(init.body) : null;',
    '  window.calls.push({ path: url.pathname, method, body });',
    '  if (url.pathname === "/forge/v1/projects" || url.pathname.endsWith("/lifecycle/list")) return Response.json({ projects: [{ project_id: "PROJECT-A", root: "/fixture/a" }] });',
    '  if (url.pathname.endsWith("/agents")) { const role = url.searchParams.get("role"); return Response.json(role ? agents.filter(a => a.role === role) : agents); }',
    '  if (url.pathname.endsWith("/conversations")) return Response.json([{ id: "CONV-1", title: "Workspace conversation" }]);',
    '  if (url.pathname.includes("/messages")) return Response.json({ items: [], has_more: false });',
    '  if (url.pathname.endsWith("/plan-clarifications") || url.pathname.includes("/notebook")) return Response.json([]);',
    '  if (url.pathname.endsWith("/git/status")) return Response.json({ branch: "main", files: [] });',
    '  return Response.json({ items: [], requests: [], sprints: [], tickets: [], active_sprint_id: null, status: "idle" });',
    '};',
    'class FixtureEventSource extends EventTarget {',
    '  constructor(url) { super(); this.url = url; this.readyState = 1; window.sources.push(this); queueMicrotask(() => { this.onopen?.(new Event("open")); this.dispatchEvent(new Event("open")); }); }',
    '  close() { this.readyState = 2; }',
    '}',
    'window.EventSource = FixtureEventSource;',
    'window.emitEvent = (type, payload) => {',
    '  const event = { schema_version: 1, event_id: "evt-" + Math.random().toString(36).slice(2), event_type: type, project_id: "PROJECT-A", timestamp: new Date().toISOString(), payload };',
    '  for (const source of window.sources) if (source.readyState !== 2) source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(event), lastEventId: event.event_id }));',
    '};',
    'const App = () => {',
    '  const [scope, setScope] = useState("home");',
    '  window.setWorkspaceScope = setScope;',
    '  return <ProjectWorkspace projectId="PROJECT-A">{scope === "home" ? <ArchitectureWorkspace projectId="PROJECT-A" /> : scope === "system" ? <SystemPage projectId="PROJECT-A" /> : <CodingPage projectId="PROJECT-A" />}</ProjectWorkspace>;',
    '};',
    'createRoot(document.getElementById("root")).render(<App />);'
  ].join("\n");

  const compiled = await build({
    stdin: { contents: source, resolveDir: join(sourceRoot, "ui/nextjs"), loader: "jsx" },
    bundle: true,
    write: false,
    jsx: "automatic",
    outfile: "fixture.js",
    alias: {
      react: join(sourceRoot, "ui/nextjs/node_modules/react"),
      "react-dom": join(sourceRoot, "ui/nextjs/node_modules/react-dom")
    },
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL": '""',
      "process.env": "{}"
    },
    plugins: [{
      name: "fixture-navigation",
      setup(builder) {
        builder.onResolve({ filter: /^next\/(navigation|link)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: args.path.endsWith("link")
            ? 'import React from "react";export default function Link({children,...props}){return React.createElement("a",props,children)}'
            : 'export const useParams=()=>({projectId:"PROJECT-A"});export const usePathname=()=>"/PROJECT-A";export const useRouter=()=>({push:()=>{},replace:()=>{},refresh:()=>{}});',
          loader: "js"
        }));
      }
    }]
  });

  return {
    html: '<!doctype html><html lang="vi"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    assets: Object.fromEntries(compiled.outputFiles.map((file) => [file.path.endsWith(".css") ? "/fixture.css" : "/fixture.js", file.text]))
  };
}

/**
 * Switches the rendered workspace inside the active Chromium page and awaits its primary landmark.
 */
async function switchScope(page, scope) {
  await page.evaluate((nextScope) => window.setWorkspaceScope(nextScope), scope);
  const label = scope === "home"
    ? "NodeForge conversation workspace"
    : scope === "system"
      ? "NodeForge system workspace"
      : "Coding workspace monitor";
  await page.getByRole("main", { name: label, exact: true }).waitFor();
}

/**
 * Verifies that Watcher and Agent activity monitor dock buttons and floating panels open and close.
 */
async function assertSystemMonitorsOperate(page) {
  const dock = page.locator(".workspace-monitor-dock");
  await dock.waitFor();
  const watcherDockBtn = dock.getByRole("button", { name: "Watcher", exact: true });
  const agentDockBtn = dock.getByRole("button", { name: "Agent activity", exact: true });
  const watcherRegion = page.getByRole("region", { name: "Watcher monitor", exact: true });
  const agentRegion = page.getByRole("region", { name: "Agent activity monitor", exact: true });

  await watcherRegion.waitFor();
  await agentRegion.waitFor();
  assert.equal(await watcherDockBtn.getAttribute("aria-pressed"), "true");
  assert.equal(await agentDockBtn.getAttribute("aria-pressed"), "true");

  await page.getByRole("button", { name: "Close Watcher monitor", exact: true }).click();
  assert.equal(await watcherRegion.count(), 0);
  assert.equal(await watcherDockBtn.getAttribute("aria-pressed"), "false");
  await watcherDockBtn.click();
  await watcherRegion.waitFor();
  assert.equal(await watcherDockBtn.getAttribute("aria-pressed"), "true");

  await page.getByRole("button", { name: "Close Agent monitor", exact: true }).click();
  assert.equal(await agentRegion.count(), 0);
  assert.equal(await agentDockBtn.getAttribute("aria-pressed"), "false");
  await agentDockBtn.click();
  await agentRegion.waitFor();
  assert.equal(await agentDockBtn.getAttribute("aria-pressed"), "true");
}

/**
 * Maps every approved acceptance assertion string to an executable Playwright verification function.
 */
export const browserAssertions = {
  "In AM home, the workspace monitor dock exposes Notebook and its button opens and closes the real Notebook panel.": async ({ page }) => {
    await switchScope(page, "home");
    const dock = page.locator(".workspace-monitor-dock");
    await dock.waitFor();
    const notebookBtn = dock.getByRole("button", { name: "Sổ tay", exact: true });
    await notebookBtn.waitFor();
    assert.equal(await notebookBtn.getAttribute("aria-pressed"), "false");

    const hiddenPanel = page.locator(".notebook-panel");
    assert.equal(await hiddenPanel.count(), 1);
    assert.equal(await hiddenPanel.isVisible(), false);

    await notebookBtn.click();
    const openPanel = page.getByRole("region", { name: "Sổ tay", exact: true });
    await openPanel.waitFor();
    assert.equal(await notebookBtn.getAttribute("aria-pressed"), "true");
    assert.equal(await notebookBtn.getAttribute("aria-expanded"), "true");
    await openPanel.getByLabel("Sổ tay mới", { exact: true }).waitFor();

    await openPanel.getByRole("button", { name: "Đóng Sổ tay", exact: true }).click();
    assert.equal(await notebookBtn.getAttribute("aria-pressed"), "false");
    assert.equal(await openPanel.isVisible(), false);

    await notebookBtn.click();
    await openPanel.waitFor();
    await notebookBtn.click();
    assert.equal(await notebookBtn.getAttribute("aria-pressed"), "false");
    assert.equal(await openPanel.isVisible(), false);
  },

  "In System, the workspace monitor dock has no Notebook button and no Notebook panel is mounted.": async ({ page }) => {
    await switchScope(page, "system");
    const dock = page.locator(".workspace-monitor-dock");
    await dock.waitFor();
    await dock.getByRole("button", { name: "Watcher", exact: true }).waitFor();
    assert.equal(await dock.getByRole("button", { name: "Sổ tay", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Sổ tay", exact: true }).count(), 0);
    assert.equal(await page.locator(".notebook-panel").count(), 0);
    assert.equal(await page.getByRole("region", { name: "Sổ tay", exact: true }).count(), 0);
  },

  "In Coding, the workspace monitor dock has no Notebook button or Notebook panel.": async ({ page }) => {
    await switchScope(page, "coding");
    const dock = page.locator(".workspace-monitor-dock");
    await dock.waitFor({ state: "attached" });
    assert.equal(await dock.getByRole("button", { name: "Sổ tay", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Sổ tay", exact: true }).count(), 0);
    assert.equal(await page.locator(".notebook-panel").count(), 0);
    assert.equal(await page.getByRole("region", { name: "Sổ tay", exact: true }).count(), 0);
  },

  "Watcher and Agent activity controls work in AM and System, and Coding agent dock controls still open and close their corresponding panels.": async ({ page }) => {
    await switchScope(page, "home");
    await assertSystemMonitorsOperate(page);

    await switchScope(page, "system");
    await assertSystemMonitorsOperate(page);

    await switchScope(page, "coding");
    await page.waitForFunction(() => window.sources.some((source) => source.readyState === 1));
    await page.evaluate(() => {
      window.emitEvent("agent.activity", {
        agent_id: "CODER-1",
        activity_type: "tool_call",
        status: "working",
        summary: "Implementing workspace scope"
      });
    });

    const dock = page.locator(".workspace-monitor-dock");
    const coderDockBtn = dock.getByRole("button", { name: "Alpha Coder", exact: true });
    await coderDockBtn.waitFor();
    const coderPanel = page.locator('.coding-agent-monitor[data-agent-id="CODER-1"]');
    await coderPanel.waitFor();
    assert.equal(await coderDockBtn.getAttribute("aria-pressed"), "true");

    await coderPanel.getByRole("button", { name: "Close agent panel CODER-1 in project PROJECT-A", exact: true }).click();
    assert.equal(await coderPanel.count(), 0);
    assert.equal(await coderDockBtn.getAttribute("aria-pressed"), "false");

    await coderDockBtn.click();
    await coderPanel.waitFor();
    assert.equal(await coderDockBtn.getAttribute("aria-pressed"), "true");
  }
};
