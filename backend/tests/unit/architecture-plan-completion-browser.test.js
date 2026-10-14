// Verifies Architecture completion becomes one durable conversation notice and leaves plan approval on Coding.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { join } from "node:path";
import { build } from "esbuild";
import { clarificationFixture } from "./architecture-clarification-fixture.js";
import { launchProjectChromium } from "../helpers/chromium-cdp.js";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";
import { routeArchitectureClarifications } from "../../src/transport/http/forge-v1-clarification-routes.js";
import { readArchitectureDecisions } from "../../src/modules/governance/architecture-owner-decisions.js";

test("Architecture with no unresolved choices publishes one completion notice without approval or dispatch", async (context) => {
  const fixture = await clarificationFixture(context, []);
  const messages = [];
  const ownerChatService = createOwnerChatService({ bus: { send: (message) => { messages.push(message); return message; }, sendFast: (message) => { messages.push(message); return message; } }, commandService: fixture.command, projectLogger: () => {}, agentStream: async function* ({ payload }) { yield { text: await fixture.provider(payload.text) }; } });
  const response = await ownerChatService.submit({ project_id: "PROJECT-A", conversation_id: "CONV-A", agent_id: "architecture-manager", message_id: "MSG-PLAN-COMPLETION", correlation_id: "CORR-PLAN-COMPLETION", sender_id: "OWNER-A", timestamp: new Date().toISOString(), payload: { text: "/plan workflows/input.md" } });
  assert.equal(response.message_type, "owner.command.result");
  assert.match(response.payload.text, /Vào trang Coding để xem và approve plan/);
  assert.equal(response.payload.status, "awaiting_human_approval");
  assert.equal(response.payload.run_started, false);
  assert.equal(messages.filter((message) => message.message_type === "owner.command.result").length, 1);
  assert.equal(messages.some((message) => message.message_type.startsWith("architecture.")), false);
  assert.equal(fixture.records.length, 1);
  assert.deepEqual(readArchitectureDecisions(fixture.records[0].markdown).decisions, []);
});

test("Chromium: completed owner choices disappear and a single conversation notice survives reload without approval", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1" }, async (context) => {
  const fixture = await clarificationFixture(context);
  await fixture.start();
  const messages = [];
  const ownerChatService = createOwnerChatService({ bus: { send: (message) => { messages.push(message); return message; }, sendFast: (message) => { messages.push(message); return message; } }, commandService: fixture.command, projectLogger: () => {}, agentStream: async function* ({ payload }) { yield { text: await fixture.provider(payload.text) }; } });
  const source = `import React,{useEffect,useMemo,useRef} from './ui/nextjs/node_modules/react/index.js';
    import {createRoot} from './ui/nextjs/node_modules/react-dom/client.js';
    import {ArchitectureClarifications} from './ui/nextjs/components/architecture-clarifications.jsx';
    import {useConversationMessageHistory} from './ui/nextjs/lib/use-conversation-message-history.js';
    window.pageIdentity=crypto.randomUUID();
    // Reads isolated owner-choice endpoints while preserving server errors for the question wizard.
    async function request(path,options){const response=await fetch(path,options);const result=await response.json();if(!response.ok)throw new Error(result.message);return result;}
    // Exercises the production question wizard and durable history without an SSE completion signal.
    function Fixture(){
      const client=useMemo(()=>({
        listArchitectureClarifications:()=>request('/sessions'),getConversationMessages:()=>request('/messages'),
        saveArchitectureChoices:(_project,_conversation,session,selections,notes,token)=>request('/choices',{method:'PATCH',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({version:session.version,source_sha256:session.source_sha256,selections,notes})}),
        confirmArchitectureChoices:(_project,_conversation,session,token)=>request('/confirm',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({version:session.version,source_sha256:session.source_sha256})})
      }),[]);
      const chatMessagesRef=useRef(null),agentDirectoryRef=useRef([]);
      const history=useConversationMessageHistory({client,projectId:'PROJECT-A',chatMessagesRef,agentDirectoryRef,agentDisplayName:()=> 'Architecture'});
      useEffect(()=>{void history.loadConversationMessages('CONV-A');},[]);
      return <><div role='log' ref={chatMessagesRef}>{history.messages.map(message=><p className='completion-message' key={message.stream_key}>{message.text}</p>)}</div>
        <ArchitectureClarifications client={client} projectId='PROJECT-A' conversationId='CONV-A' agentId='architecture-manager' onPlanCreated={result=>history.loadConversationMessages(result.conversation_id,{preserve:true})}/></>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const compiled = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "jsx" }, bundle: true, write: false, jsx: "automatic", alias: { react: join(process.cwd(), "ui/nextjs/node_modules/react") }, define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/") { response.setHeader("content-type", "text/html"); response.end('<div id="root"></div><script src="/app.js"></script>'); return; }
      if (request.url === "/app.js") { response.setHeader("content-type", "application/javascript"); response.end(compiled.outputFiles[0].text); return; }
      response.setHeader("content-type", "application/json");
      if (request.url === "/sessions") { response.end(JSON.stringify(await fixture.command.planningSessions.list("CONV-A"))); return; }
      if (request.url === "/messages") {
        response.end(JSON.stringify({ items: messages.filter((message) => message.message_type === "owner.command.result").map((message) => ({ id: message.id, kind: "response", conversation_id: message.conversation_id, correlation_id: message.correlation_id, timestamp: message.timestamp, content: message.payload })) })); return;
      }
      let text = ""; for await (const chunk of request) text += chunk;
      const session = (await fixture.command.planningSessions.list("CONV-A"))[0];
      const result = await routeArchitectureClarifications({ method: request.method, parts: ["conversations", "CONV-A", "plan-clarifications", session.session_id, ...(request.url === "/confirm" ? ["confirm"] : [])], body: JSON.parse(text), projectId: "PROJECT-A", conversation: { id: "CONV-A", project_id: "PROJECT-A", agent_id: "architecture-manager" }, headers: request.headers, ownerChatService, planOwnerAuth: { verify: (headers) => { assert.equal(headers.authorization, "Bearer TEST-OWNER"); return "OWNER-A"; } } });
      response.statusCode = result.status; response.end(JSON.stringify(result.body));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ message: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await launchProjectChromium(join(fixture.root, "profile"));
  context.after(() => browser.close());
  const page = await browser.page(`http://127.0.0.1:${server.address().port}/`);
  await page.wait("document.querySelectorAll('input[type=radio]').length===2");
  const identity = await page.evaluate("window.pageIdentity");
  await page.click("document.querySelector('input[type=password]')"); await page.send("Input.insertText", { text: "TEST-OWNER" });
  await page.click("document.querySelector('input[type=radio]')");
  await page.wait("document.querySelector('.architecture-clarification-source').textContent.includes('1 đã lưu')");
  await page.click("[...document.querySelectorAll('button')].find(button=>button.textContent==='Xem lại quyết định')");
  await page.wait("Boolean([...document.querySelectorAll('button')].find(button=>button.textContent==='Xác nhận & tạo plan' && !button.disabled))");
  await page.click("[...document.querySelectorAll('button')].find(button=>button.textContent==='Xác nhận & tạo plan')");
  await page.wait("document.querySelectorAll('.completion-message').length===1 && !document.querySelector('.architecture-clarification-card')");
  assert.equal(await page.evaluate("window.pageIdentity"), identity);
  assert.match(await page.evaluate("document.querySelector('.completion-message').textContent"), /Đã tạo plan .*Vào trang Coding để xem và approve plan\. Chưa RUN\./);
  assert.equal(await page.evaluate("document.body.textContent.includes('Quyết định đã ghi vào plan') || document.body.textContent.includes('Xem và duyệt plan')"), false);
  assert.equal(messages.filter((message) => message.message_type === "owner.command.result").length, 1);
  assert.equal(messages.some((message) => message.message_type === "architecture.message.received"), false);
  assert.equal(fixture.records.length, 1);
  assert.equal(fixture.records[0].status, "awaiting_human_approval");
  assert.equal(readArchitectureDecisions(fixture.records[0].markdown).decisions[0].option_id, "LOCAL");
  await page.send("Page.reload");
  await page.wait("document.querySelectorAll('.completion-message').length===1 && !document.querySelector('.architecture-clarification-card')");
  assert.equal(messages.filter((message) => message.message_type === "owner.command.result").length, 1);
});
