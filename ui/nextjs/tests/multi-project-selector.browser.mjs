// Verify real project management, conversation requests, and stream isolation at every approved viewport.
import assert from "node:assert/strict";
import { join } from "node:path";

// Bundle the production workspace and conversation page, replacing external HTTP and SSE I/O only.
export async function createBrowserFixture({ sourceRoot, build }) {
  const source = `import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {ProjectWorkspace} from './components/project-workspace.jsx';
    import HomePage from './app/page.jsx';
    import './app/globals.css';
    window.calls=[];window.sources=[];window.held=[];window.fixtureErrors=[];
    window.addEventListener('error',event=>window.fixtureErrors.push(event.error?.stack??event.message));
    window.addEventListener('unhandledrejection',event=>window.fixtureErrors.push(String(event.reason?.stack??event.reason)));
    window.projects=[{project_id:'PROJECT-A',root:'/projects/a'}];
    window.delayA=new URLSearchParams(location.search).has('delay');
    // Return representative persisted conversation history from the controlled transport.
    const history=(project,text)=>({items:[{id:'history-'+project,kind:'agent',agent_id:'architect',conversation_id:'conversation-'+project,timestamp:'2026-10-20T00:00:00Z',content:{text,content_type:'text/plain'}}]});
    // Preserve request shapes so assertions can distinguish management, reads, and mutations.
    window.fetch=async(input,init={})=>{
      const url=new URL(input,location.origin);const body=init.body?JSON.parse(init.body):null;
      const project=url.searchParams.get('project')??url.searchParams.get('project_id')??body?.project_id??null;
      const method=init.method??'GET';window.calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),body,method});
      if(url.pathname.endsWith('/lifecycle/list'))return Response.json({projects:window.projects});
      if(url.pathname.endsWith('/lifecycle/add')){
        if(Object.keys(body).join()!=='root')throw new Error('Lifecycle add must be root-only');
        if(!body.root.startsWith('/'))return Response.json({error:{code:'INVALID_ROOT',message:'Use an absolute project root.'}},{status:400});
        const added={project_id:'PROJECT-B',root:body.root};window.projects.push(added);return Response.json(added);
      }
      if(url.pathname.endsWith('/lifecycle/remove')){
        if(Object.keys(body).join()!=='root')throw new Error('Lifecycle remove must be root-only');
        window.projects=window.projects.filter(item=>item.root!==body.root);return Response.json({removed:true,root:body.root});
      }
      if(url.pathname.endsWith('/agents'))return Response.json({agents:[{agent_id:'architect',agent_name:'Architect',role:'architecture_manager',enabled:true}]});
      if(url.pathname.endsWith('/conversations')&&method==='GET')return Response.json({items:[{id:'conversation-'+project,title:'Conversation '+project,agent_id:'architect',project_id:project}]});
      if(url.pathname.endsWith('/conversations')&&method==='POST')return Response.json({id:'conversation-'+project,project_id:project,agent_id:'architect'});
      if(url.pathname.endsWith('/messages')&&method==='GET'){
        if(window.delayA&&project==='PROJECT-A')return new Promise(resolve=>window.held.push(()=>resolve(Response.json(history(project,'STALE A RESPONSE')))));
        return Response.json(history(project,'History '+project));
      }
      if(url.pathname.endsWith('/messages')&&method==='POST')return Response.json({status:'accepted',message_id:body.message_id,conversation_id:'conversation-'+project});
      if(url.pathname.endsWith('/plan-clarifications'))return Response.json([]);
      if(url.pathname.endsWith('/git/status'))return Response.json({branch:'main',clean:true,files:[]});
      return Response.json({items:[],project_id:project});
    };
    // Keep closed socket handlers callable to test queued delivery rather than trusting mock cleanup.
    window.EventSource=class {
      constructor(url){this.url=url;this.handlers={};this.readyState=1;this.closed=false;window.sources.push(this);queueMicrotask(()=>this.onopen?.({}));}
      addEventListener(type,handler){(this.handlers[type]??=[]).push(handler);}
      close(){this.closed=true;this.readyState=2;}
      emit(type,data){for(const handler of this.handlers[type]??[])handler({data:JSON.stringify(data),lastEventId:data.event_id});}
    };
    createRoot(document.getElementById('root')).render(<ProjectWorkspace><HomePage/></ProjectWorkspace>);`;
  const compiled = await build({
    stdin: { contents: source, resolveDir: join(sourceRoot, "ui/nextjs"), loader: "jsx" },
    bundle: true, write: false, jsx: "automatic", outfile: "fixture.js",
    alias: { react: join(sourceRoot, "ui/nextjs/node_modules/react"), "react-dom": join(sourceRoot, "ui/nextjs/node_modules/react-dom") },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL": '""', "process.env": "{}" }
  });
  return {
    html: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    assets: Object.fromEntries(compiled.outputFiles.map((file) => [file.path.endsWith(".css") ? "/fixture.css" : "/fixture.js", file.text]))
  };
}

// Start each scenario with a real automatically selected single-project workspace.
async function openWorkspace(page, origin, delayed = false) {
  await page.goto(`${origin}/${delayed ? "?delay=1" : ""}`);
  await page.waitForFunction(() => document.querySelector('select[aria-label="Project"]')?.value === "PROJECT-A" && window.sources.length > 0);
  if (!delayed) {
    try { await page.getByText("History PROJECT-A", { exact: true }).waitFor(); }
    catch (error) { throw new Error(`${error.message}; workspace diagnostics: ${await page.evaluate(() => JSON.stringify({ errors: window.fixtureErrors, body: document.body.innerHTML.slice(0, 2000), calls: window.calls }))}`); }
  }
}

// Add a second managed root using the production form and its actual lifecycle client.
async function addSecondProject(page) {
  const rootInput = page.getByRole("textbox", { name: "Project root", exact: true });
  if (await rootInput.count() !== 1) throw new Error(`Project root control unavailable: ${await page.evaluate(() => JSON.stringify({ errors: window.fixtureErrors, body: document.body.innerHTML.slice(0, 1000), calls: window.calls, management: document.querySelector('[aria-label="Project management"]')?.outerHTML, ancestors: [...document.querySelectorAll('[aria-hidden], [inert]')].map(element => element.outerHTML.slice(0, 300)), inputs: [...document.querySelectorAll('input')].map(element => ({ html: element.outerHTML, display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility })) }))}`);
  await rootInput.fill("/projects/b");
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="Project"] option[value="PROJECT-B"]'));
}

// Switch through the real selection control and wait for the replacement workspace's persisted history.
async function chooseSecondProject(page) {
  await page.getByRole("combobox", { name: "Project", exact: true }).selectOption("PROJECT-B");
  await page.getByText("History PROJECT-B", { exact: true }).waitFor();
}

export const browserAssertions = {
  "Selecting project B after project A sends subsequent project-bound requests and the active stream subscription with B's identity through existing request shapes.": async ({ page, origin }) => {
    await openWorkspace(page, origin); await addSecondProject(page);
    const offset = await page.evaluate(() => window.calls.length);
    await chooseSecondProject(page);
    await page.getByRole("textbox", { name: "Chat or ticket input" }).fill("Message for B");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.waitForFunction(() => window.calls.some(call => call.method === "POST" && call.path.endsWith("/messages")));
    const evidence = await page.evaluate((start) => ({ calls: window.calls.slice(start), sources: window.sources.map(source => ({ project: new URL(source.url).searchParams.get("project"), closed: source.closed })) }), offset);
    const reads = evidence.calls.filter(call => call.method === "GET" && call.path.endsWith("/messages"));
    const writes = evidence.calls.filter(call => call.method === "POST" && call.path.endsWith("/messages"));
    assert.ok(reads.length && writes.length);
    for (const call of [...reads, ...writes]) assert.equal(call.query.project, "PROJECT-B");
    for (const call of writes) assert.equal(call.body.project_id, "PROJECT-B");
    assert.ok(evidence.sources.filter(source => source.project === "PROJECT-A").every(source => source.closed));
    assert.ok(evidence.sources.some(source => source.project === "PROJECT-B" && !source.closed));
  },
  "Adding a project through the existing management API makes it selectable, and a single configured project is usable without an extra selection step.": async ({ page, origin }) => {
    await openWorkspace(page, origin);
    assert.equal(await page.getByRole("combobox", { name: "Project", exact: true }).inputValue(), "PROJECT-A");
    await page.getByRole("textbox", { name: "Project root", exact: true }).fill("relative-root");
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "absolute project root" }).waitFor();
    await addSecondProject(page); await chooseSecondProject(page);
    const additions = await page.evaluate(() => window.calls.filter(call => call.path.endsWith("/lifecycle/add")));
    assert.deepEqual(additions.at(-1).body, { root: "/projects/b" });
    assert.deepEqual(additions.at(-1).query, {});
    assert.equal(await page.getByRole("combobox", { name: "Project", exact: true }).inputValue(), "PROJECT-B");
  },
  "Delayed responses and stream events from project A do not appear as project B data after switching.": async ({ page, origin }) => {
    await openWorkspace(page, origin, true);
    await page.waitForFunction(() => window.held.length > 0);
    await addSecondProject(page); await chooseSecondProject(page);
    await page.evaluate(() => {
      for (const release of window.held) release();
      for (const source of window.sources) {
        const project = new URL(source.url).searchParams.get("project");
        source.emit("conversation.message.owner", { event_id: `event-${project}`, schema_version: 1, project_id: project, timestamp: "2026-10-20T00:00:00Z", event_type: "conversation.message.owner", payload: { conversation_id: `conversation-${project}`, message_id: `message-${project}`, text: project === "PROJECT-A" ? "STALE A EVENT" : "CURRENT B EVENT" } });
      }
    });
    await page.getByText("CURRENT B EVENT", { exact: true }).waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText("STALE A RESPONSE", { exact: true }).count(), 0);
    assert.equal(await page.getByText("STALE A EVENT", { exact: true }).count(), 0);
    assert.equal(await page.getByText("History PROJECT-A", { exact: true }).count(), 0);
    assert.ok(await page.evaluate(() => window.sources.filter(source => new URL(source.url).searchParams.get("project") === "PROJECT-A").every(source => source.closed)));
  },
  "Removing or losing the selected project shows a recoverable state and never silently routes work to another project.": async ({ page, origin }) => {
    await openWorkspace(page, origin); await addSecondProject(page); await chooseSecondProject(page);
    await page.getByRole("button", { name: "Remove project", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "unavailable" }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Chat or ticket input" }).count(), 0);
    assert.equal(await page.getByRole("combobox", { name: "Project", exact: true }).inputValue(), "");
    const offset = await page.evaluate(() => window.calls.length);
    await page.getByRole("button", { name: "Refresh projects", exact: true }).click();
    await page.waitForFunction((start) => window.calls.length > start, offset);
    assert.ok((await page.evaluate((start) => window.calls.slice(start), offset)).every(call => call.path.endsWith("/lifecycle/list")));
    await page.getByRole("combobox", { name: "Project", exact: true }).selectOption("PROJECT-A");
    await page.getByText("History PROJECT-A", { exact: true }).waitFor();
    await page.evaluate(() => { window.projects = []; });
    await page.getByRole("button", { name: "Refresh projects", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "unavailable" }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Chat or ticket input" }).count(), 0);
    assert.ok(await page.evaluate(() => window.sources.every(source => source.closed)));
  },
  "Project addition and selection controls remain visible and operable without horizontal page overflow at the approved viewport width.": async ({ page, viewport, origin }) => {
    await openWorkspace(page, origin);
    for (const control of [page.getByRole("combobox", { name: "Project", exact: true }), page.getByRole("textbox", { name: "Project root", exact: true }), page.getByRole("button", { name: "Add project", exact: true })]) {
      assert.ok(await control.isVisible());
      const box = await control.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= viewport + 1);
    }
    await addSecondProject(page); await chooseSecondProject(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "page has no horizontal overflow");
    await page.getByRole("combobox", { name: "Project", exact: true }).focus();
    await page.keyboard.press("Home"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    assert.ok(["PROJECT-A", "PROJECT-B"].includes(await page.getByRole("combobox", { name: "Project", exact: true }).inputValue()));
  }
};
