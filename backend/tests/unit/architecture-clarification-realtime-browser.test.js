// Verifies Architecture choices appear in the mounted conversation immediately after /plan, including when SSE misses its result.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { join } from "node:path";
import { build } from "esbuild";
import { clarificationFixture } from "./architecture-clarification-fixture.js";
import { launchProjectChromium } from "../helpers/chromium-cdp.js";

test("Chromium: HTTP planning completion renders choices without reload, polling or an SSE notification", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1" }, async (context) => {
  const fixture = await clarificationFixture(context);
  const conversationId = "123e4567-e89b-42d3-a456-426614174000";
  const requests = [];
  const source = `import React,{useMemo} from "./ui/nextjs/node_modules/react/index.js";
    import {createRoot} from "./ui/nextjs/node_modules/react-dom/client.js";
    import {ArchitectureClarifications} from "./ui/nextjs/components/architecture-clarifications.jsx";
    import {createCodingPlanEvents} from "./ui/nextjs/lib/coding-plan-events.js";
    import {createHomeMessageHandlers} from "./ui/nextjs/lib/home-page-message-handlers.js";
    window.pageIdentity=crypto.randomUUID();
    // Exercises the mounted wizard through the production owner-command handlers without emitting an SSE event.
    function Fixture(){
      const events=useMemo(()=>createCodingPlanEvents("PROJECT-A"),[]);
      const client=useMemo(()=>({listArchitectureClarifications:async()=>{const response=await fetch('/sessions');const sessions=await response.json();window.sessionReads=(window.sessionReads??0)+1;return sessions},postOwnerMessage:async()=>{const response=await fetch('/start',{method:'POST'});return response.json()}}),[]);
      const handlers=createHomeMessageHandlers({client,projectId:'PROJECT-A',activeConversationId:'${conversationId}',selectedArchitectureManager:{id:'architecture-manager'},setChatState(){},setMessages(){},setAgentTyping(){},sendingRef:{current:false},lastSentRef:{current:null},onCommandResult:events.publishCommandResult});
      return <><button id="start" onClick={()=>handlers.sendMessage('/plan workflows/input.md')}>Create plan</button><ArchitectureClarifications client={client} projectId="PROJECT-A" conversationId="${conversationId}" agentId="architecture-manager" planEvents={events}/></>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const compiled = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "jsx" }, bundle: true, write: false, jsx: "automatic", alias: { react: join(process.cwd(), "ui/nextjs/node_modules/react"), "react-dom": join(process.cwd(), "ui/nextjs/node_modules/react-dom") }, define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer(async (request, response) => {
    try {
      requests.push(`${request.method} ${request.url}`);
      if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><div id="root"></div><script src="/app.js"></script>'); return; }
      if (request.url === "/app.js") { response.setHeader("Content-Type", "text/javascript"); response.end(compiled.outputFiles[0].text); return; }
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/sessions") { response.end(JSON.stringify(await fixture.command.planningSessions.list(conversationId))); return; }
      if (request.method === "POST" && request.url === "/start") {
        const result = await fixture.command.execute({ text: "/plan workflows/input.md", conversationId, requestArchitecture: fixture.provider });
        response.end(JSON.stringify({ project_id: "PROJECT-A", conversation_id: conversationId, message_type: "owner.command.result", payload: result })); return;
      }
      response.statusCode = 404; response.end("{}");
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await launchProjectChromium(join(fixture.root, "browser-profile"));
  context.after(() => browser.close());
  const page = await browser.page(`http://127.0.0.1:${server.address().port}/`);
  await page.wait("document.querySelector('.architecture-clarifications') && document.readyState === 'complete'");
  await page.wait("window.sessionReads === 1");
  await page.wait("!document.querySelector('input[type=radio]')");
  const identity = await page.evaluate("window.pageIdentity");
  await page.click("document.querySelector('#start')");
  await page.wait("document.querySelectorAll('input[type=radio]').length === 2");
  assert.equal(await page.evaluate("window.pageIdentity"), identity);
  assert.equal(await page.evaluate("document.querySelectorAll('input[type=radio]:checked').length"), 0);
  assert.equal(requests.filter((request) => request === "POST /start").length, 1);
  assert.equal(requests.filter((request) => request === "GET /").length, 1);
  assert.equal(requests.filter((request) => request === "GET /sessions").length, 2);
  assert.equal(fixture.records.length, 0);
  assert.equal(fixture.prompts.length, 1);
  console.log(`Architecture realtime verification: ${browser.version.product}, choices rendered without reload or SSE; no automatic approval.`);
});
