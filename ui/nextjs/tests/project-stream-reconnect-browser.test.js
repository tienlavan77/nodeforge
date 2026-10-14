// Proves real Chromium resumes project events after API downtime without reloading the page.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { launchProjectChromium } from "../../../backend/tests/helpers/chromium-cdp.js";
import { proxyControlApi } from "../lib/control-api-proxy.js";

// Exercises browser-native SSE, the actual UI proxy and an upstream socket stop/restart together.
test("Chromium reconnects after proxy 503 with preserved cursor and mounted page", { timeout: 30000 }, async (context) => {
  const directory = await mkdtemp(join(process.cwd(), ".forge/runtime/project-stream-reconnect-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  context.mock.method(console, "warn", () => {});
  const cursors = [];
  let revision = 1;
  const backend = createServer((request, response) => {
    cursors.push(new URL(request.url, "http://backend.test").searchParams.get("after"));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = { event_id: `EVT-${revision}`, event_type: "agent.activity", project_id: "PROJECT-A", schema_version: 1, timestamp: "2026-10-14T00:00:00Z", payload: {} };
    response.write(`retry: 100\nid: ${event.event_id}\nevent: agent.activity\ndata: ${JSON.stringify(event)}\n\n`);
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const port = backend.address().port;
  context.after(() => new Promise((resolve) => { backend.closeAllConnections(); backend.close(resolve); }));
  const compiled = await build({ stdin: { contents: `
    import {createProjectStreamClient} from './ui/nextjs/lib/project-stream-client.js';
    window.mountId=crypto.randomUUID();window.received=[];window.opens=0;window.errors=0;
    const connect=createProjectStreamClient((path,params)=>path+'?'+new URLSearchParams(params));
    window.subscription=connect({projectId:'PROJECT-A',onEvent:event=>window.received.push(event.event_id),onOpen:()=>window.opens++,onError:()=>window.errors++});
  `, resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser" });
  const ui = createServer(async (request, response) => {
    if (request.url.startsWith("/stream")) {
      const result = await proxyControlApi(new Request(`http://ui.test${request.url}`, { headers: request.headers }), ["stream"], { origin: `http://127.0.0.1:${port}` });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      Readable.fromWeb(result.body).pipe(response);
    } else {
      response.setHeader("content-type", request.url === "/bundle.js" ? "text/javascript" : "text/html");
      response.end(request.url === "/bundle.js" ? compiled.outputFiles[0].text : '<!doctype html><script src="/bundle.js"></script>');
    }
  });
  await new Promise((resolve) => ui.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { ui.closeAllConnections(); ui.close(resolve); }));
  const browser = await launchProjectChromium(join(directory, "profile"));
  context.after(() => browser.close());
  const page = await browser.page(`http://127.0.0.1:${ui.address().port}/`);
  await page.wait("window.received?.includes('EVT-1') && window.opens === 1");
  const identity = await page.evaluate("window.mountId");
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
  await page.wait("window.errors >= 2");
  revision = 2;
  await new Promise((resolve) => backend.listen(port, "127.0.0.1", resolve));
  await page.wait("window.received?.includes('EVT-2') && window.opens === 2");
  assert.equal(await page.evaluate("window.mountId"), identity);
  assert.deepEqual(await page.evaluate("window.received"), ["EVT-1", "EVT-2"]);
  assert.equal(cursors.at(-1), "EVT-1");
  await page.evaluate("window.subscription.close()");
});
