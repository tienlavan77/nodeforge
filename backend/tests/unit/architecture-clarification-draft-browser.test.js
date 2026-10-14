// Verifies owners can select Architecture options before authenticating while durable confirmation still requires owner authority.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { clarificationFixture } from "./architecture-clarification-fixture.js";
import { launchProjectChromium } from "../helpers/chromium-cdp.js";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";
import { routeArchitectureClarifications } from "../../src/transport/http/forge-v1-clarification-routes.js";
import { readArchitectureDecisions } from "../../src/modules/governance/architecture-owner-decisions.js";

test("Chromium: draft choices are clickable, rejected credentials do not approve, and confirmation saves the latest version first", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1" }, async (context) => {
  const fixture = await clarificationFixture(context);
  const pending = await fixture.start();
  const ownerChatService = createOwnerChatService({ bus: { send() {}, sendFast() {} }, commandService: fixture.command, agentStream: async function* ({ payload }) { yield { text: await fixture.provider(payload.text) }; } });
  const requests = [];
  const source = `import React,{useState,useEffect} from "./ui/nextjs/node_modules/react/index.js";
    import {createRoot} from "./ui/nextjs/node_modules/react-dom/client.js";
    import {ArchitectureClarificationCard} from "./ui/nextjs/components/architecture-clarification-card.jsx";
    // Drives the real question card against authenticated, versioned clarification routes.
    function Fixture(){
      const [session,setSession]=useState(null);
      // Retrieves only durable choices for this isolated owner session.
      async function refresh(){const response=await fetch('/session');const current=await response.json();setSession(current);window.session=current;}
      useEffect(()=>{refresh()},[]);
      // Saves an explicit owner draft using the actual session version and supplied credential.
      async function save(current,selections,notes,token){const response=await fetch('/session',{method:'PATCH',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({version:current.version,source_sha256:current.source_sha256,selections,notes})});const result=await response.json();if(!response.ok)throw new Error(result.message);setSession(result);window.session=result;return result;}
      // Confirms only the saved revision, then displays the resulting unapproved plan state.
      async function confirm(current,token){const response=await fetch('/confirm',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({version:current.version,source_sha256:current.source_sha256})});const result=await response.json();if(!response.ok)throw new Error(result.message);await refresh();}
      return session?<ArchitectureClarificationCard session={session} onSave={save} onConfirm={confirm} onReload={refresh}/>:null;
    } createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const compiled = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "jsx" }, bundle: true, write: false, jsx: "automatic", alias: { react: join(process.cwd(), "ui/nextjs/node_modules/react") }, define: { "process.env.NODE_ENV": '"production"' } });
  const css = await readFile("ui/nextjs/app/styles/architecture-clarifications.css", "utf8");
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end(`<!doctype html><style>${css}</style><div id="root"></div><script src="/app.js"></script>`); return; }
      if (request.url === "/app.js") { response.setHeader("Content-Type", "text/javascript"); response.end(compiled.outputFiles[0].text); return; }
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET") { response.end(JSON.stringify(await fixture.command.planningSessions.get(pending.session_id))); return; }
      let text = ""; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text); requests.push({ method: request.method, body });
      const parts = ["conversations", "CONV-A", "plan-clarifications", pending.session_id, ...(request.url === "/confirm" ? ["confirm"] : [])];
      const result = await routeArchitectureClarifications({ method: request.method, parts, body, projectId: "PROJECT-A", conversation: { id: "CONV-A", project_id: "PROJECT-A", agent_id: "architecture-manager" }, headers: request.headers, ownerChatService, planOwnerAuth: { verify: (headers) => { if (headers.authorization !== "Bearer TEST-OWNER") throw Object.assign(new Error("Owner authentication required"), { statusCode: 401 }); return "OWNER-A"; } } });
      response.statusCode = result.status; response.end(JSON.stringify(result.body));
    } catch (error) { response.statusCode = error.statusCode ?? 500; response.end(JSON.stringify({ message: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await launchProjectChromium(join(fixture.root, "browser-profile"));
  context.after(() => browser.close());
  const page = await browser.page(`http://127.0.0.1:${server.address().port}/`);
  await page.wait("document.querySelectorAll('input[type=radio]').length === 2");
  await page.click("document.querySelectorAll('.architecture-clarification-option')[1]");
  await page.wait("document.querySelectorAll('input[type=radio]')[1].checked");
  await page.click("document.querySelector('textarea')"); await page.send("Input.insertText", { text: "Owner chọn đồng bộ server" });
  await page.click("[...document.querySelectorAll('button')].find(control=>control.textContent==='Xem lại quyết định')");
  await page.wait("document.querySelector('h4')?.textContent === 'Xem lại quyết định'");
  assert.equal(requests.length, 0);
  assert.equal(await page.evaluate("[...document.querySelectorAll('button')].find(control=>control.textContent==='Xác nhận & tạo plan').disabled"), true);
  await page.click("document.querySelector('input[type=password]')"); await page.send("Input.insertText", { text: "WRONG" });
  await page.click("[...document.querySelectorAll('button')].find(control=>control.textContent==='Xác nhận & tạo plan')");
  await page.wait("document.querySelector('[role=alert]')?.textContent.includes('Owner authentication required')");
  assert.equal(requests.length, 1); assert.equal(requests[0].method, "PATCH");
  assert.equal(fixture.records.length, 0);
  assert.deepEqual((await fixture.command.planningSessions.get(pending.session_id)).selections, {});
  await page.click("document.querySelector('input[type=password]')");
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
  await page.send("Input.insertText", { text: "TEST-OWNER" });
  await page.click("[...document.querySelectorAll('button')].find(control=>control.textContent==='Xác nhận & tạo plan')");
  await page.wait("window.session.status === 'completed'");
  assert.deepEqual(requests.map((request) => request.method), ["PATCH", "PATCH", "POST"]);
  assert.equal(requests[2].body.version, requests[1].body.version + 1);
  assert.equal(fixture.records.length, 1); assert.equal(fixture.records[0].status, "awaiting_human_approval");
  const decisions = readArchitectureDecisions(fixture.records[0].markdown);
  assert.equal(decisions.owner_id, "OWNER-A"); assert.equal(decisions.decisions[0].option_id, "SERVER"); assert.equal(decisions.decisions[0].owner_note, "Owner chọn đồng bộ server");
  console.log(`Architecture draft click verification: ${browser.version.product}, token-free draft, auth rejection and exact-version confirmation PASS.`);
});
