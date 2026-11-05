/**
 * Bundles the real admitted Architecture Manager workspace, project lifecycle, conversation list,
 * and floating workspace monitors for Chromium verification of the Notebook persistent monitor.
 * External HTTP, EventSource, storage writes, and console logs are captured deterministically so
 * browser scenarios can verify window geometry persistence and prove content privacy.
 */
import { join } from "node:path";

/**
 * Compiles the real Next.js Architecture Manager workspace and Notebook floating monitor into a
 * self-contained browser bundle while capturing console and storage activity for privacy checks.
 */
export async function createBrowserFixture({ sourceRoot, build }) {
  const source = [
    'import React from "react";',
    'import { createRoot } from "react-dom/client";',
    'import ArchitectureWorkspace from "./components/architecture-workspace.jsx";',
    'import { ProjectWorkspace } from "./components/project-workspace.jsx";',
    'import "./app/globals.css";',
    'window.calls = []; window.sources = []; window.consoleLogs = []; window.storageWrites = [];',
    'for (const level of ["log", "info", "warn", "error", "debug"]) {',
    '  const orig = console[level].bind(console);',
    '  console[level] = (...args) => { window.consoleLogs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); orig(...args); };',
    '}',
    'for (const [storeName, store] of [["localStorage", window.localStorage], ["sessionStorage", window.sessionStorage]]) {',
    '  const origSet = store.setItem.bind(store);',
    '  store.setItem = (key, value) => { window.storageWrites.push({ store: storeName, key: String(key), value: String(value) }); return origSet(key, value); };',
    '}',
    'window.records = [{ id: "notebook-1", project_id: "PROJECT-A", content: "Existing project notebook", status: "open", version: 1 }];',
    'window.fetch = async (input, init = {}) => {',
    '  const url = new URL(input, location.origin), method = init.method || "GET", body = init.body ? JSON.parse(init.body) : null;',
    '  window.calls.push({ path: url.pathname, method, body });',
    '  if (url.pathname === "/forge/v1/projects" || url.pathname.endsWith("/lifecycle/list")) return Response.json({ projects: [{ project_id: "PROJECT-A", root: "/fixture/a" }] });',
    '  if (url.pathname.endsWith("/agents")) return Response.json([',
    '    { agent_id: "AM-1", agent_name: "First agent", role: "architecture_manager", enabled: true, project_id: "PROJECT-A" },',
    '    { agent_id: "AM-2", agent_name: "Second agent", role: "architecture_manager", enabled: true, project_id: "PROJECT-A" }',
    '  ]);',
    '  if (url.pathname.endsWith("/conversations")) return Response.json([',
    '    { id: "CONV-1", title: "First conversation" },',
    '    { id: "CONV-2", title: "Second conversation" }',
    '  ]);',
    '  if (url.pathname.includes("/messages")) return Response.json({ items: [], has_more: false });',
    '  if (url.pathname.endsWith("/plan-clarifications")) return Response.json([]);',
    '  if (url.pathname.endsWith("/git/status")) return Response.json({ branch: "main", files: [] });',
    '  if (url.pathname.includes("/notebook")) {',
    '    const id = decodeURIComponent(url.pathname.split("/").at(-1)), item = window.records.find((entry) => entry.id === id);',
    '    const fault = window.nextNotebookFailure;',
    '    if (fault && (!fault.method || fault.method === method)) {',
    '      window.nextNotebookFailure = null;',
    '      if (fault.type === "network") throw new TypeError(fault.message || "Failed to fetch");',
    '      return Response.json({ error: { code: fault.code || "request_failed", message: fault.message || "HTTP error" } }, { status: fault.status || 503 });',
    '    }',
    '    if (method === "GET") return Response.json(id === "notebook" ? window.records : item ?? null);',
    '    if (method === "POST") {',
    '      const created = { id: "notebook-" + (window.records.length + 1), project_id: "PROJECT-A", content: body.content, status: "open", version: 1, position: 0 };',
    '      window.records = [created, ...window.records.map((entry, idx) => ({ ...entry, position: idx + 1 }))]; return Response.json(created, { status: 201 });',
    '    }',
    '    if (method === "PATCH" && item) {',
    '      if (body.expected_version !== undefined && body.expected_version !== item.version) {',
    '        return Response.json({ error: { code: "notebook_version_conflict", message: "Notebook version conflict." } }, { status: 409 });',
    '      }',
    '      Object.assign(item, body, { version: item.version + 1 }); delete item.expected_version;',
    '      if (typeof body.position === "number") {',
    '        const rest = window.records.filter((entry) => entry.id !== item.id);',
    '        const bounded = Math.max(0, Math.min(body.position, rest.length));',
    '        rest.splice(bounded, 0, item);',
    '        window.records = rest.map((entry, idx) => ({ ...entry, position: idx }));',
    '      }',
    '      return Response.json(item);',
    '    }',
    '    if (method === "DELETE" && item) {',
    '      const expected = Number(url.searchParams.get("expected_version") ?? body?.expected_version);',
    '      if (expected && expected !== item.version) {',
    '        return Response.json({ error: { code: "notebook_version_conflict", message: "Notebook version conflict." } }, { status: 409 });',
    '      }',
    '      window.records = window.records.filter((entry) => entry.id !== id);',
    '      return Response.json({ deleted: true, id, project_id: "PROJECT-A" });',
    '    }',
    '  }',
    '  return Response.json({ items: [], requests: [], status: "idle" });',
    '};',
    'class FixtureEventSource extends EventTarget {',
    '  constructor(url) { super(); this.url = url; this.readyState = 1; window.sources.push(this); queueMicrotask(() => { this.onopen?.(new Event("open")); this.dispatchEvent(new Event("open")); }); }',
    '  close() { this.readyState = 2; }',
    '}',
    'window.EventSource = FixtureEventSource;',
    'const root = createRoot(document.getElementById("root"));',
    'window.mountKey = 0;',
    'window.renderApp = () => root.render(<ProjectWorkspace key={window.mountKey} projectId="PROJECT-A"><ArchitectureWorkspace projectId="PROJECT-A" /></ProjectWorkspace>);',
    'window.renderApp();'
  ].join("\n");

  const compiled = await build({
    stdin: { contents: source, resolveDir: join(sourceRoot, "ui/nextjs"), loader: "jsx" },
    bundle: true,
    write: false,
    jsx: "automatic",
    outfile: "fixture.js",
    alias: {
      react: join(sourceRoot, "ui/nextjs/node_modules/react"),
      "react-dom": join(sourceRoot, "ui/nextjs/node_modules/react-dom"),
    },
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL": '""',
      "process.env": "{}",
    },
    plugins: [{
      name: "fixture-navigation",
      setup(builder) {
        builder.onResolve({ filter: /^next\/(navigation|link)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: args.path.endsWith("link")
            ? 'import React from "react";export default function Link({children,...props}){return React.createElement("a",props,children)}'
            : 'export const useParams=()=>({projectId:"PROJECT-A"});export const usePathname=()=>"/PROJECT-A";export const useRouter=()=>({push:()=>{},replace:()=>{},refresh:()=>{}});',
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
