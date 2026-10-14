// Verifies active Coding tabs do not repeatedly fetch plans on connection and visibility notifications.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { launchProjectChromium } from "../../../backend/tests/helpers/chromium-cdp.js";

test("Coding coalesces initial connections and active-tab refreshes but immediately loads changed plans", { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(process.cwd(), ".forge/runtime/coding-plan-refresh-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const compiled = await build({ stdin: { contents: `
    import {createRoot} from 'react-dom/client';
    import {CodingArchitecturePlans} from './components/coding-architecture-plans.jsx';
    import {createCodingPlanEvents} from './lib/coding-plan-events.js';
    window.reads={lists:0,revisions:0};
    window.events=createCodingPlanEvents('PROJECT');
    const plan={plan_id:'PLAN-A',revision:1,sha256:'a'.repeat(64),format:'markdown',status:'awaiting_human_approval',markdown:'# Plan: Review me'};
    const client={
      listPlans:async()=>{window.reads.lists++;return [plan]},
      listPlanRequests:async()=>[],
      getPlanRevision:async()=>{window.reads.revisions++;return {...plan}}
    };
    createRoot(document.getElementById('root')).render(<CodingArchitecturePlans client={client} projectId="PROJECT" planEvents={window.events}/>);
  `, resolveDir: join(process.cwd(), "ui/nextjs"), loader: "jsx" }, bundle: true, jsx: "automatic", write: false, format: "iife", platform: "browser" });
  const server = createServer((request, response) => {
    response.setHeader("content-type", request.url === "/bundle.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/bundle.js" ? compiled.outputFiles[0].text : '<!doctype html><div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await launchProjectChromium(join(directory, "profile"));
  t.after(() => browser.close());
  const page = await browser.page(`http://127.0.0.1:${server.address().port}/`);
  await page.wait("document.body?.textContent.includes('Review me')");
  assert.deepEqual(await page.evaluate("window.reads"), { lists: 1, revisions: 1 });
  await page.evaluate(`(async()=>{
    for(let i=0;i<5;i++) {
      window.events.publish({project_id:'PROJECT',event_type:'stream.connected'});
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    await new Promise(resolve=>setTimeout(resolve,200));
  })()`);
  assert.deepEqual(await page.evaluate("window.reads"), { lists: 1, revisions: 1 });
  await page.evaluate("window.events.publish({project_id:'PROJECT',event_type:'plan.request.persisted',payload:{request_id:'REQUEST-A',plan_id:'PLAN-A',revision:1,sha256:'a'.repeat(64)}})");
  await page.wait("window.reads.revisions === 2");
  assert.deepEqual(await page.evaluate("window.reads"), { lists: 2, revisions: 2 });
});
