// Verifies the Agents page uses the shared shell and ConversationSidebar, operates without project admission or Git status requests, and recovers from timeout errors through real Chromium interactions.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { launchProjectChromium } from "../../../backend/tests/helpers/chromium-cdp.js";
import { proxyControlApi } from "../lib/control-api-proxy.js";

process.env.NODEFORGE_AGENTS_BROWSER_TEST ??= "1";

// Business purpose: provisions a self-contained same-origin UI proxy and upstream Control API when an external application URL is not supplied so the Chromium Agents directory test always executes without skipping.
// Technical description: bundles `AgentsPage` with Next navigation stubs and CSS, forwards `/forge/v1/*` requests through `proxyControlApi` to a local upstream HTTP/SSE server, and returns the local `/agents` URL.
async function startProvisionedAgentsApp(context) {
  const backend = createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://127.0.0.1");
    if (pathname === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`retry: 100\nid: EVT-1\nevent: stream.connected\ndata: ${JSON.stringify({ event_id: "EVT-1", event_type: "stream.connected", project_id: "PROJECT-NODEFORGE", schema_version: 1, timestamp: "2026-10-31T00:00:00Z", payload: {} })}\n\n`);
      return;
    }
    if (pathname === "/agents") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ agents: [
        { agent_id: "am-1", agent_name: "Architect One", role: "architecture_manager", team: "Backend", enabled: true, status: "ready", provider: "anthropic", model: "claude-opus-4-6", reasoning: { effort: "medium" }, tool_mode: "forge", gateway_url: "https://gw.test/am" },
        { agent_id: "coder-1", agent_name: "Coder One", role: "coder", team: "Backend", enabled: true, status: "working", provider: "anthropic", model: "claude-sonnet-4-6", reasoning: { effort: "medium" }, tool_mode: "forge", gateway_url: "https://gw.test/coder" }
      ] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendOrigin = `http://127.0.0.1:${backend.address().port}`;
  context.after(() => new Promise((resolve) => { backend.closeAllConnections(); backend.close(resolve); }));
  const compiled = await build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import AgentsPage from './app/agents/page.jsx';import './app/globals.css';createRoot(document.getElementById('root')).render(<AgentsPage/>);`, resolveDir: join(process.cwd(), "ui/nextjs"), loader: "jsx" },
    bundle: true, write: false, jsx: "automatic", outfile: "bundle.js",
    plugins: [{ name: "next-stubs", setup(b) {
      b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next-nav", namespace: "ns" }));
      b.onLoad({ filter: /^next-nav$/, namespace: "ns" }, () => ({ contents: `export const usePathname=()=>'/agents';export const useParams=()=>({});export const useRouter=()=>({push(){},replace(){}});`, loader: "js" }));
      b.onResolve({ filter: /^next\/link$/ }, () => ({ path: "next-link", namespace: "ns" }));
      b.onLoad({ filter: /^next-link$/, namespace: "ns" }, () => ({ contents: `import React from 'react';export default function Link({href,children,...rest}){return <a href={href} {...rest}>{children}</a>;}`, loader: "jsx" }));
    } }],
    alias: { react: join(process.cwd(), "ui/nextjs/node_modules/react"), "react-dom": join(process.cwd(), "ui/nextjs/node_modules/react-dom") },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL": '""', "process.env": "{}" }
  });
  const assets = Object.fromEntries(compiled.outputFiles.map((file) => [file.path.endsWith(".css") ? "/bundle.css" : "/bundle.js", file.text]));
  const catalog = await readFile(new URL("../public/model-catalog.json", import.meta.url), "utf8");
  const ui = createServer(async (req, res) => {
    const reqUrl = new URL(req.url, "http://127.0.0.1");
    if (reqUrl.pathname.startsWith("/forge/v1/")) {
      const pathSegments = reqUrl.pathname.slice("/forge/v1/".length).split("/").filter(Boolean);
      const proxied = await proxyControlApi(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers }), pathSegments, { origin: backendOrigin });
      res.writeHead(proxied.status, Object.fromEntries(proxied.headers));
      if (proxied.body) Readable.fromWeb(proxied.body).pipe(res); else res.end();
      return;
    }
    if (reqUrl.pathname === "/model-catalog.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(catalog); return; }
    if (reqUrl.pathname === "/bundle.js" || reqUrl.pathname === "/bundle.css") {
      res.writeHead(200, { "content-type": reqUrl.pathname.endsWith(".css") ? "text/css" : "text/javascript" });
      res.end(assets[reqUrl.pathname]); return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise((resolve) => ui.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { ui.closeAllConnections(); ui.close(resolve); }));
  return `http://127.0.0.1:${ui.address().port}/agents`;
}

test("Agents page integrates with claude-home-shell and ConversationSidebar without NodeForgeHeader, project admission, or Git status requests", async () => {
  const agentsPage = await readFile(new URL("../app/agents/page.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(agentsPage, /NodeForgeHeader/);
  assert.doesNotMatch(agentsPage, /GitStatusIndicator|ConversationHeaderProjectGit|getGitStatus/);
  assert.match(agentsPage, /className="[^"]*\bclaude-home-shell\b[^"]*\bagents-workspace-shell\b[^"]*"/);
  assert.ok(agentsPage.includes("<ConversationSidebar") && agentsPage.includes('agentSectionTitle="Agents"') && agentsPage.includes("showConversationControls={false}"));
  assert.match(agentsPage, /<header\b(?=[^>]*className="[^"]*\bclaude-chat-header\b[^"]*\bagents-page-header\b[^"]*")[^>]*>\s*<h1>Agents<\/h1>\s*<\/header>/);
  assert.match(agentsPage, /\$\{agents\.length\} agents/);
  assert.match(agentsPage, /streamState === "connected" \? "live" : streamState === "error" \? "stream offline" : "connecting…"/);
  assert.match(agentsPage, /aria-label="Add agent"/);
  assert.match(agentsPage, /aria-label="Toggle agent"/);
});

test("Chromium: Agents loads through the UI proxy and recovers from a stalled API without page reload", { skip: process.env.NODEFORGE_AGENTS_BROWSER_TEST !== "1", timeout: 60000 }, async (context) => {
  await mkdir(`${process.cwd()}/.forge/runtime`, { recursive: true });
  const root = await mkdtemp(`${process.cwd()}/.forge/runtime/agents-browser-`);
  const browser = await launchProjectChromium(`${root}/profile`);
  context.after(async () => { await browser.close(); await rm(root, { recursive: true, force: true }); });
  const targetUrl = process.env.NODEFORGE_AGENTS_UI_URL ?? await startProvisionedAgentsApp(context);
  const page = await browser.page("about:blank");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__agentsProbe={hang:true,urls:[],streamUrls:[],errors:[]};window.EventSource=new Proxy(window.EventSource,{construct(Target,args){window.__agentsProbe.streamUrls.push(String(args[0]));return Reflect.construct(Target,args)}});const nativeFetch=window.fetch;window.fetch=(url,init={})=>{if(new URL(url,location.href).pathname==='/forge/v1/agents'){window.__agentsProbe.urls.push(String(url));if(window.__agentsProbe.hang)return new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true})})}return nativeFetch(url,init)};const nativeTimeout=window.setTimeout;window.setTimeout=(callback,delay,...args)=>nativeTimeout(callback,delay===15000?100:delay,...args);window.addEventListener('error',event=>window.__agentsProbe.errors.push(event.message));` });
  await page.send("Page.navigate", { url: targetUrl });
  await page.wait("Boolean(document.querySelector('.agents-directory-state.error'))");
  assert.match(await page.evaluate("document.querySelector('.agents-directory-state.error').textContent"), /timed out/);
  assert.equal(await page.evaluate("Boolean([...document.querySelectorAll('.agents-directory-state')].find(element=>element.textContent.includes('Loading agents')))"), false);
  await page.evaluate("window.__agentsProbe.hang=false");
  await page.click("[...document.querySelectorAll('button')].find(control=>control.textContent==='Retry')");
  await page.wait("Boolean(document.querySelector('.agents-card-grid') && document.querySelectorAll('.agent-directory-card').length>1)");
  await page.wait("Boolean(document.querySelector('[title=\"Project stream connected.\"]'))");
  const probe = await page.evaluate("({urls:window.__agentsProbe.urls,streamUrls:window.__agentsProbe.streamUrls,errors:window.__agentsProbe.errors,origin:location.origin,alert:!!document.querySelector('.agents-directory-state.error'),cards:document.querySelectorAll('.agent-directory-card').length,navigationCount:performance.getEntriesByType('navigation').length})");
  assert.equal(probe.alert, false); assert.equal(probe.navigationCount, 1); assert.deepEqual(probe.errors, []);
  assert.ok(probe.urls.length > 1); assert.ok(probe.urls.every((url) => new URL(url, probe.origin).origin === probe.origin));
  assert.ok(probe.streamUrls.length > 0); assert.ok(probe.streamUrls.every((url) => new URL(url, probe.origin).origin === probe.origin));
  console.log(`Agents browser verification: NODEFORGE_AGENTS_BROWSER_TEST=${process.env.NODEFORGE_AGENTS_BROWSER_TEST}, ${browser.version.product}, ${probe.cards - 1} profiles, same-origin timeout and Retry PASS`);
});
