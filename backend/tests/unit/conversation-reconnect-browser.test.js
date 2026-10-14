// Verifies mounted conversation hooks recover missed System Engineer replies after SSE reconnect without a page reload.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { launchProjectChromium } from "../helpers/chromium-cdp.js";

test("Chromium: SE reply recovery preserves live history, drafts and the mounted page", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1" }, async (context) => {
  const root = await mkdtemp(join(process.cwd(), ".forge/runtime/conversation-reconnect-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = `import React,{useEffect,useMemo,useRef,useState} from './ui/nextjs/node_modules/react/index.js';
    import {createRoot} from './ui/nextjs/node_modules/react-dom/client.js';
    import {useConversationMessageHistory} from './ui/nextjs/lib/use-conversation-message-history.js';
    import {useProjectEventStream} from './ui/nextjs/lib/home-page-event-stream.js';
    window.pageIdentity=crypto.randomUUID();window.historyReads=0;
    window.records=[{id:'OWNER',kind:'owner',conversation_id:'CONV-A',correlation_id:'CORR-A',content:{text:'Question'},timestamp:'2026-10-13T00:00:00Z'}];
    function Fixture(){
      const chatMessagesRef=useRef(null),agentDirectoryRef=useRef([]),activeConversationIdRef=useRef('CONV-A');
      const [streamState,setStreamState]=useState('connecting');
      const client=useMemo(()=>({
        getConversationMessages:async()=>{window.historyReads++;if(window.failHistory)throw new Error('Recovery unavailable');return {items:window.records.slice().reverse()};},
        connectProjectStream:options=>{window.stream=options;queueMicrotask(()=>options.onOpen());return {close(){}};}
      }),[]);
      const history=useConversationMessageHistory({client,projectId:'PROJECT-A',chatMessagesRef,agentDirectoryRef,agentDisplayName:()=> 'System Engineer'});
      useProjectEventStream({client,projectId:'PROJECT-A',activeConversationIdRef,agentDirectoryRef,setMessages:history.setMessages,setAgentTyping(){},setWatcherState:setStreamState,
        setWatcherEvents(){},setWatcherPulseId(){},setAgentProcess(){},agentDisplayName:()=> 'System Engineer',onConversationReconnect:history.loadConversationMessages});
      useEffect(()=>{void history.loadConversationMessages('CONV-A');window.addDraft=()=>history.setMessages(current=>[...current,{id:'DRAFT',from:'owner',pending:true,text:'Unsent',timestamp:'2026-10-13T00:03:00Z'}]);},[]);
      window.viewMessages=history.messages;
      return <><p id='state'>{streamState}</p><p id='error'>{history.historyError}</p><p id='loading'>{String(history.messagesLoading)}</p><div ref={chatMessagesRef}>{history.messages.map(message=><p key={message.stream_key??message.id}>{message.text}</p>)}</div></>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const bundle = await build({ stdin: { contents: source, loader: "jsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", jsxImportSource: "react", nodePaths: [join(process.cwd(), "ui/nextjs/node_modules")], define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((request, response) => {
    response.setHeader("content-type", request.url === "/bundle.js" ? "application/javascript" : "text/html");
    response.end(request.url === "/bundle.js" ? bundle.outputFiles[0].text : '<div id="root"></div><script src="/bundle.js"></script>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await launchProjectChromium(join(root, "profile"));
  context.after(() => browser.close());
  const page = await browser.page(`http://127.0.0.1:${server.address().port}/`);
  await page.wait("window.historyReads === 1 && window.viewMessages?.length === 1");
  const identity = await page.evaluate("window.pageIdentity");
  await page.evaluate(`window.addDraft();window.stream.onEvent({project_id:'PROJECT-A',event_type:'conversation.message.delta',timestamp:'2026-10-13T00:01:00Z',event_id:'DELTA',payload:{conversation_id:'CONV-A',correlation_id:'CORR-A',chunk:'Partial'}});`);
  await page.wait("window.viewMessages.some(message=>message.text==='Partial')");
  await page.evaluate(`window.stream.onError();window.records.push({id:'FINAL',kind:'agent',agent_id:'SE',conversation_id:'CONV-A',correlation_id:'CORR-A',content:{text:'Completed SE response'},timestamp:'2026-10-13T00:02:00Z'});window.stream.onOpen();`);
  await page.wait("window.viewMessages.some(message=>message.text==='Completed SE response')");
  assert.equal(await page.evaluate("window.pageIdentity"), identity);
  assert.equal(await page.evaluate("window.historyReads"), 2);
  assert.equal(await page.evaluate("window.viewMessages.length"), 3);
  assert.equal(await page.evaluate("window.viewMessages.find(message=>message.id==='DRAFT').pending"), true);
  assert.equal(await page.evaluate("document.getElementById('loading').textContent"), "false");
  await page.evaluate("window.failHistory=true;window.stream.onError();window.stream.onOpen();");
  await page.wait("document.getElementById('error').textContent==='Recovery unavailable'");
  assert.equal(await page.evaluate("window.viewMessages.length"), 3);
  await page.evaluate("window.failHistory=false;window.stream.onOpen();");
  await page.wait("window.historyReads===4 && document.getElementById('error').textContent===''");
  assert.equal(await page.evaluate("window.viewMessages.length"), 3);
});
