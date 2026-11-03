/**
 * Bundles the real admitted Architecture Manager project workspace, Notebook dock, Notebook panel, and
 * session/client store for Chromium verification of quiet initial loading and compact quick entry.
 * External HTTP responses and EventSource transport are deterministically controlled so browser
 * assertions can exercise initial-list outages, CRUD, 409 conflicts, and uncertain write recovery.
 */
import { join } from "node:path";

/**
 * Compiles the production Next.js project workspace and Notebook components into a browser
 * bundle with programmable HTTP fault injection for initial list loads and mutation endpoints.
 */
export async function createBrowserFixture({ sourceRoot, build }) {
  const source = [
    'import React from "react";',
    'import { createRoot } from "react-dom/client";',
    'import ArchitectureWorkspace from "./components/architecture-workspace.jsx";',
    'import { ProjectWorkspace } from "./components/project-workspace.jsx";',
    'import { getNotebookSession } from "./lib/notebook-session.js";',
    'import "./app/globals.css";',
    'window.calls = []; window.sources = []; localStorage.clear(); sessionStorage.clear();',
    'window.control = { listMode: "ok", mutationMode: "ok", projectId: "PROJECT-A", mountKey: 0 };',
    'window.records = [];',
    'window.fetch = async (input, init = {}) => {',
    '  const url = new URL(input, location.origin), method = init.method || "GET", body = init.body ? JSON.parse(init.body) : null;',
    '  const project = url.searchParams.get("project_id") || body?.project_id || window.control.projectId;',
    '  window.calls.push({ path: url.pathname, method, body, project });',
    '  if (url.pathname === "/forge/v1/projects" || url.pathname.endsWith("/lifecycle/list")) return Response.json({ projects: [{ project_id: window.control.projectId, root: "/fixture/a" }] });',
    '  if (url.pathname.endsWith("/agents")) return Response.json([{ agent_id: "AM-1", agent_name: "First agent", role: "architecture_manager", enabled: true, project_id: window.control.projectId }]);',
    '  if (url.pathname.endsWith("/conversations")) return Response.json([{ id: "CONV-1", title: "First conversation" }]);',
    '  if (url.pathname.includes("/messages")) return Response.json({ items: [], has_more: false });',
    '  if (url.pathname.endsWith("/plan-clarifications")) return Response.json([]);',
    '  if (url.pathname.endsWith("/git/status")) return Response.json({ branch: "main", files: [] });',
    '  if (url.pathname.includes("/notebook")) {',
    '    const id = decodeURIComponent(url.pathname.split("/").at(-1)), item = window.records.find((entry) => entry.id === id);',
    '    if (method === "GET" && id === "notebook") {',
    '      if (window.control.listMode === "no-repo") return Response.json({ error: { message: "Project repository is not available" } }, { status: 404 });',
    '      if (window.control.listMode === "503-port") return Response.json({ error: { message: "Notebook project permission port is not configured" } }, { status: 503 });',
    '      if (window.control.listMode === "network-error") throw new TypeError("Failed to fetch initial notebook list");',
    '      return Response.json(window.records.filter((entry) => entry.project_id === project));',
    '    }',
    '    if (method === "GET") return Response.json(item ?? null);',
    '    if (window.control.mutationMode === "fail-503") return Response.json({ error: { message: "Notebook write service unavailable" } }, { status: 503 });',
    '    if (window.control.mutationMode === "lost-after-commit") {',
    '      if (method === "POST") window.records.push({ id: "notebook-" + (window.records.length + 1), project_id: project, content: body.content, status: "open", version: 1 });',
    '      throw new TypeError("Network connection lost after commit");',
    '    }',
    '    if (method === "POST") {',
    '      const created = { id: "notebook-" + (window.records.length + 1), project_id: project, content: body.content, status: "open", version: 1 };',
    '      window.records.push(created); return Response.json(created, { status: 201 });',
    '    }',
    '    const expectedVersion = method === "PATCH" ? body.expected_version : Number(url.searchParams.get("expected_version"));',
    '    if (!item || item.version !== expectedVersion) return Response.json({ error: { message: "Notebook version conflict" } }, { status: 409 });',
    '    if (method === "PATCH") {',
    '      Object.assign(item, body, { version: item.version + 1 }); delete item.expected_version;',
    '      if (typeof body.position === "number") {',
    '        const rest = window.records.filter((entry) => entry.id !== item.id);',
    '        const bounded = Math.max(0, Math.min(body.position, rest.length));',
    '        rest.splice(bounded, 0, item);',
    '        window.records = rest.map((entry, idx) => ({ ...entry, position: idx }));',
    '      }',
    '      return Response.json(item);',
    '    }',
    '    if (method === "DELETE") { window.records = window.records.filter((entry) => entry !== item); return Response.json({ deleted: true, id }); }',
    '  }',
    '  return Response.json({ items: [], requests: [], status: "idle" });',
    '};',
    'class FixtureEventSource extends EventTarget {',
    '  constructor(url) { super(); this.url = url; this.readyState = 1; window.sources.push(this); queueMicrotask(() => { this.onopen?.(new Event("open")); this.dispatchEvent(new Event("open")); }); }',
    '  close() { this.readyState = 2; }',
    '}',
    'window.EventSource = FixtureEventSource;',
    'const root = createRoot(document.getElementById("root"));',
    'window.renderApp = () => root.render(<ProjectWorkspace key={window.control.projectId + "-" + window.control.mountKey} projectId={window.control.projectId}><ArchitectureWorkspace projectId={window.control.projectId} /></ProjectWorkspace>);',
    'window.switchScenario = ({ projectId, listMode = "ok", mutationMode = "ok", records = [], draft = null }) => {',
    '  window.calls = []; window.records = records; window.control.projectId = projectId;',
    '  window.control.listMode = listMode; window.control.mutationMode = mutationMode; window.control.mountKey++;',
    '  if (draft) getNotebookSession(projectId).changeDraft(draft);',
    '  window.renderApp();',
    '};',
    'window.renderApp();'
  ].join("\n");

  const compiled = await build({
    stdin: { contents: source, resolveDir: join(sourceRoot, "ui/nextjs"), loader: "jsx" },
    bundle: true, write: false, jsx: "automatic", outfile: "fixture.js",
    alias: { react: join(sourceRoot, "ui/nextjs/node_modules/react"), "react-dom": join(sourceRoot, "ui/nextjs/node_modules/react-dom") },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL": '""', "process.env": "{}" },
    plugins: [{
      name: "fixture-navigation",
      setup(builder) {
        builder.onResolve({ filter: /^next\/(navigation|link)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: args.path.endsWith("link")
            ? 'import React from "react";export default function Link({children,...props}){return React.createElement("a",props,children)}'
            : 'export const useParams=()=>({projectId:window.control?.projectId||"PROJECT-A"});export const usePathname=()=>"/"+(window.control?.projectId||"PROJECT-A");export const useRouter=()=>({push:()=>{},replace:()=>{},refresh:()=>{}});',
          loader: "js",
        }));
      },
    }],
  });

  return {
    html: '<!doctype html><html lang="vi"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    assets: Object.fromEntries(compiled.outputFiles.map((file) => [file.path.endsWith(".css") ? "/fixture.css" : "/fixture.js", file.text])),
  };
}
