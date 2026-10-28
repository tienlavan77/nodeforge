// Exercises the production directory, cards, dialogs, SSE progress streams, and route-scoped workspaces in Chromium.
// Business purpose: verifies O4 acceptance criteria across mobile, tablet, and desktop viewports using real bundled Next.js UI components against controlled HTTP and SSE boundaries.
// Technical description: exports `createBrowserFixture` and `browserAssertions` covering single-GET catalog loading without polling, preflight-assisted Add modal, ready card navigation, full Section 5 Edit modal, file-preserving Delete confirmation, backend error visibility, and dynamic `[projectId]` workspace isolation.
import assert from "node:assert/strict";
import { join } from "node:path";

// Bundle real application components and expose controlled external responses for O4 project lifecycle and route-scoped workspace checks.
export async function createBrowserFixture({ sourceRoot, build }) {
  const navStub = [
    "import {createContext,useContext} from 'react';",
    "export const NavContext=createContext({pathname:'/',params:{},router:{push(){},replace(){}}});",
    "export const usePathname=()=>useContext(NavContext).pathname;",
    "export const useParams=()=>useContext(NavContext).params;",
    "export const useRouter=()=>useContext(NavContext).router;",
    "export const redirect=p=>{window.navigateTo?.(p);};"
  ].join("\n");
  const source = [
    "import React,{useEffect,useMemo,useState} from 'react';import {createRoot} from 'react-dom/client';",
    "import {NavContext} from 'next/navigation';",
    "import HomePage from './app/page.jsx';import ProjectPage from './app/[projectId]/page.jsx';",
    "import ProjectCodingPage from './app/[projectId]/coding/page.jsx';import ProjectSystemPage from './app/[projectId]/system/page.jsx';",
    "import * as selection from './lib/project-selection.js';import * as lifecycle from './lib/project-lifecycle-client.js';import * as directory from './lib/project-directory-client.js';",
    "import './app/globals.css';",
    "window.api={...selection,...lifecycle,...directory};window.calls=[];window.sources=[];window.navigated=[];window.fixtureErrors=[];",
    "window.addEventListener('error',e=>window.fixtureErrors.push(e.error?.stack??e.message));",
    "window.addEventListener('unhandledrejection',e=>window.fixtureErrors.push(String(e.reason?.stack??e.reason)));",
    "window.mock={preflightError:null,addError:null,editError:null,deleteError:null,projects:[",
    "{project_id:'alpha-running',name:'Alpha Running',description:'Running indexing service',author:'Owner A',root:'/server/alpha',readiness:'running',progress:{stage:'comment_normalization',status:'running',stages:{preflight:'completed',comment_normalization:'running'}},diagnostic:null},",
    "{project_id:'beta-ready',name:'Beta Ready',description:'Ready production workspace',author:'Owner B',root:'/server/beta',git_url:'https://example.org/beta.git',default_branch:'main',default_workflow_id:'WF-MAIN',language:'javascript',package_manager:'pnpm',comment_language:'en',commands:{test:'pnpm test',lint:'pnpm lint',build:'pnpm build',dev:'pnpm dev'},default_agents:{architecture_manager:'arch-beta',sprint_leader:'sl-beta',coder:'coder-beta',reviewer:'rev-beta'},watch:{include:['src/**'],exclude:['node_modules/**']},tags:['web','core'],homepage_url:'https://beta.example.org',docs_url:'https://beta.example.org/docs',metadata:{env:'staging'},readiness:'ready',progress:{stage:'startup/readiness',status:'succeeded'},diagnostic:null},",
    "{project_id:'PROJECT-LEGACY-99',name:'Legacy Nine',description:'Legacy ID workspace',author:'Owner Legacy',root:'/server/legacy',readiness:'ready',progress:{stage:'startup/readiness',status:'succeeded'},diagnostic:null}]};",
    "window.fetch=async(input,init={})=>{const url=new URL(input,location.origin),body=init.body?JSON.parse(init.body):null,method=init.method||'GET';",
    "const project=url.searchParams.get('project')??url.searchParams.get('project_id')??body?.project_id??null;",
    "window.calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method,body});",
    "if(url.pathname==='/forge/v1/projects/preflight'&&method==='POST'){",
    "if(window.mock.preflightError)return Response.json({error:window.mock.preflightError},{status:window.mock.preflightError.status||400});",
    "const r=String(body?.root??'').trim();",
    "if(!r.startsWith('/')||r.includes('invalid')||r.includes('unsafe'))return Response.json({status:'invalid',code:'EACCES_ROOT_UNSAFE',message:'Root directory is not accessible or contains an unsafe symlink.',stage:'preflight',guidance:'Choose an owned directory on the host.'});",
    "if(r.includes('existing'))return Response.json({status:'existing',root:r,suggestions:{name:'Suggested App',description:'Suggested description from package.json',author:'Suggested Author',git_url:'https://example.org/suggested.git'}});",
    "return Response.json({status:'new',root:r});}",
    "if(url.pathname==='/forge/v1/projects'&&method==='GET')return Response.json({projects:window.mock.projects});",
    "if(url.pathname==='/forge/v1/projects'&&method==='POST'){",
    "if(window.mock.addError)return Response.json({error:window.mock.addError},{status:window.mock.addError.status||400});",
    "const slug=String(body.name||'new-project').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'new-project';",
    "const created={...body,project_id:slug,readiness:'running',progress:{stage:'preflight',status:'running',stages:{preflight:'running'}},diagnostic:null};",
    "window.mock.projects=[...window.mock.projects.filter(p=>p.project_id!==slug),created];return Response.json({project:created},{status:201});}",
    "const parts=url.pathname.split('/').filter(Boolean);",
    "if(parts[0]==='forge'&&parts[1]==='v1'&&parts[2]==='projects'&&parts.length===4&&parts[3]!=='preflight'){const id=decodeURIComponent(parts[3]);",
    "if(method==='PUT'){if(window.mock.editError)return Response.json({error:window.mock.editError},{status:window.mock.editError.status||400});",
    "const ex=window.mock.projects.find(p=>p.project_id===id);if(!ex)return Response.json({error:{code:'PROJECT_NOT_FOUND',message:'Project is not registered.'}},{status:404});",
    "const up={...ex,...body,project_id:id,root:ex.root};window.mock.projects=window.mock.projects.map(p=>p.project_id===id?up:p);return Response.json({project:up});}",
    "if(method==='DELETE'){if(window.mock.deleteError)return Response.json({error:window.mock.deleteError},{status:window.mock.deleteError.status||409});",
    "window.mock.projects=window.mock.projects.filter(p=>p.project_id!==id);return Response.json({project_id:id,removed:true});}}",
    "if(url.pathname.endsWith('/lifecycle/list'))return Response.json({projects:window.mock.projects.filter(p=>p.readiness==='ready').map(p=>({project_id:p.project_id,root:p.root,name:p.name}))});",
    "if(url.pathname.endsWith('/agents')){const role=url.searchParams.get('role'),all=[{agent_id:'arch-1',agent_name:'Architect One',role:'architecture_manager',enabled:true},{agent_id:'se-1',agent_name:'System Eng One',role:'system_engineer',enabled:true},{agent_id:'coder-1',agent_name:'Coder One',role:'coder',enabled:true,status:'ready'}];return Response.json({agents:role?all.filter(a=>a.role===role):all});}",
    "if(url.pathname.endsWith('/conversations')&&method==='GET')return Response.json({items:[{id:'conv-'+project,conversation_id:'conv-'+project,title:'Chat for '+project,agent_id:url.searchParams.get('agent_id')||'arch-1',project_id:project}]});",
    "if(url.pathname.includes('/conversations/')&&url.pathname.endsWith('/messages')&&method==='GET')return Response.json({items:[{id:'msg-'+project,kind:'agent',agent_id:'arch-1',conversation_id:'conv-'+project,timestamp:'2026-10-28T00:00:00Z',content:{text:'Welcome to '+project,content_type:'text/plain'}}]});",
    "if(parts[0]==='forge'&&parts[1]==='v1'&&parts[2]==='projects'&&parts.length===5&&parts[4]==='dashboard'){const dp=decodeURIComponent(parts[3]);return Response.json({project_id:dp,roadmap:{id:'ROADMAP-'+dp,version:'1',sprints:[{id:'SPRINT-'+dp,objective:'Deliver '+dp,status:'planned',tasks:[]}]}});}",
    "if(url.pathname.endsWith('/git/status'))return Response.json({branch:'main-'+project,clean:true,files:[]});",
    "if(url.pathname.endsWith('/plan-clarifications'))return Response.json([]);",
    "return Response.json({items:[],project_id:project});};",
    "window.EventSource=class{constructor(url){this.url=String(url);this.project=new URL(url,location.origin).searchParams.get('project');this.handlers={};this.readyState=1;this.closed=false;window.sources.push(this);queueMicrotask(()=>this.onopen?.({}));}addEventListener(t,h){(this.handlers[t]??=[]).push(h);}close(){this.closed=true;this.readyState=2;}emit(t,d){if(!this.closed)for(const h of this.handlers[t]??[])h({data:JSON.stringify(d),lastEventId:d.event_id});}};",
    "window.emitProjectSse=(projectId,eventType,payload)=>{const ev={event_id:'EVT-'+Date.now()+'-'+Math.random().toString(36).slice(2,7),event_type:eventType,schema_version:1,project_id:projectId,timestamp:new Date().toISOString(),payload};for(const s of window.sources)if(!s.closed&&s.project===projectId)s.emit(eventType,ev);};",
    "function FixtureRouterApp(){const[pathname,setPathname]=useState(()=>window.location.pathname||'/');useEffect(()=>{const onPop=()=>setPathname(window.location.pathname||'/');window.addEventListener('popstate',onPop);window.navigateTo=p=>{window.history.pushState({},'',p);window.navigated.push(p);setPathname(p);};return()=>window.removeEventListener('popstate',onPop);},[]);",
    "const segs=pathname.split('/').filter(Boolean);const nav=useMemo(()=>({pathname,params:segs[0]?{projectId:decodeURIComponent(segs[0])}:{},router:{push:p=>window.navigateTo(p),replace:p=>window.navigateTo(p)}}),[pathname]);",
    "let view=<HomePage/>;if(segs.length===1)view=<ProjectPage/>;else if(segs.length===2&&segs[1]==='coding')view=<ProjectCodingPage/>;else if(segs.length===2&&segs[1]==='system')view=<ProjectSystemPage/>;",
    "return <NavContext.Provider value={nav}>{view}</NavContext.Provider>;}",
    "createRoot(document.getElementById('root')).render(<FixtureRouterApp/>);"
  ].join("\n");
  const compiled = await build({
    stdin: { contents: source, resolveDir: join(sourceRoot, "ui/nextjs"), loader: "jsx" },
    bundle: true, write: false, jsx: "automatic", outfile: "fixture.js",
    plugins: [{ name: "next-nav", setup(b) { b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next-nav", namespace: "ns" })); b.onLoad({ filter: /.*/, namespace: "ns" }, () => ({ contents: navStub, resolveDir: join(sourceRoot, "ui/nextjs"), loader: "js" })); } }],
    alias: { react: join(sourceRoot, "ui/nextjs/node_modules/react"), "react-dom": join(sourceRoot, "ui/nextjs/node_modules/react-dom") },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL": '""', "process.env": "{}" }
  });
  return {
    html: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    assets: Object.fromEntries(compiled.outputFiles.map((file) => [file.path.endsWith(".css") ? "/fixture.css" : "/fixture.js", file.text]))
  };
}

// Open the fixture root and wait for the initial project cards to render.
async function openDirectory(page, origin) {
  if (new URL(page.url()).origin !== origin) await page.goto(origin);
  try {
    await page.waitForFunction(() => Boolean(document.querySelector('[data-project-id="alpha-running"]') && document.querySelector('[data-project-id="beta-ready"]')), null, { timeout: 5000 });
  } catch (error) {
    throw new Error(`Initial directory: ${error.message}; ${await page.evaluate(() => JSON.stringify({ errors: window.fixtureErrors, calls: window.calls, text: document.body?.innerText, html: document.body?.innerHTML?.slice(0, 500) }))}`, { cause: error });
  }
}

export const browserAssertions = {
  "Opening ProjectDirectory makes exactly one GET /forge/v1/projects request; advancing through multiple former polling intervals makes no repeated catalog or operation-status polling requests, while project SSE events update the correct card percentage, status and ready navigation.": async ({ page, origin }) => {
    await openDirectory(page, origin);
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.path === "/forge/v1/projects" && c.method === "GET").length), 1);
    await page.waitForTimeout(3200);
    const counts = await page.evaluate(() => ({
      gets: window.calls.filter((c) => c.path === "/forge/v1/projects" && c.method === "GET").length,
      polls: window.calls.filter((c) => c.path.includes("/operations/status") || c.path.includes("/lifecycle/directory")).length,
      sse: window.sources.some((s) => s.project === "alpha-running" && !s.closed)
    }));
    assert.deepEqual(counts, { gets: 1, polls: 0, sse: true });
    const alphaCard = page.locator('[data-project-id="alpha-running"]');
    assert.equal(await alphaCard.getAttribute("data-readiness"), "running");
    assert.match(await alphaCard.innerText(), /45%/);
    await page.evaluate(() => window.emitProjectSse("alpha-running", "agent.activity", { agent_id: "coder", activity_type: "progress", status: "working", summary: "Stage scan/index: running" }));
    await page.waitForFunction(() => document.querySelector('[data-project-id="alpha-running"]')?.textContent?.includes("65%"));
    assert.match(await alphaCard.innerText(), /scan\/index[\s\S]*65%/);
    await page.evaluate(() => window.emitProjectSse("alpha-running", "agent.activity", { agent_id: "coder", activity_type: "completed", status: "success", summary: "Stage startup/readiness: succeeded" }));
    await page.waitForFunction(() => document.querySelector('[data-project-id="alpha-running"]')?.getAttribute("data-readiness") === "ready");
    assert.equal(await alphaCard.getByRole("link", { name: "Open Alpha Running" }).count(), 1);
  },

  "The Add modal displays all three preflight states, fills available suggestions, requires name, description, author and root, submits without a manual Create/Add choice, closes on successful submission and displays the new running card with live SSE progress.": async ({ page, origin }) => {
    await openDirectory(page, origin);
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    const dialog = page.getByRole("dialog"); await dialog.waitFor();
    assert.equal(await dialog.getByLabel("Action").count(), 0);
    const rootInput = dialog.getByLabel("Absolute server path");
    await rootInput.fill("/server/invalid-path");
    await dialog.locator('[data-preflight-status="invalid"]').waitFor();
    assert.match(await dialog.innerText(), /EACCES_ROOT_UNSAFE/);
    await rootInput.fill("/server/new-clean-root");
    await dialog.locator('[data-preflight-status="new"]').waitFor();
    const beforePost = await page.evaluate(() => window.calls.filter((c) => c.path === "/forge/v1/projects" && c.method === "POST").length);
    await dialog.getByRole("button", { name: "Add project", exact: true }).click();
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.path === "/forge/v1/projects" && c.method === "POST").length), beforePost);
    await rootInput.fill("/server/existing-app");
    await dialog.locator('[data-preflight-status="existing"]').waitFor();
    assert.equal(await dialog.getByLabel("Project name").inputValue(), "Suggested App");
    assert.equal(await dialog.getByLabel("Description").inputValue(), "Suggested description from package.json");
    assert.equal(await dialog.getByLabel("Author").inputValue(), "Suggested Author");
    assert.equal(await dialog.getByLabel("Git URL").inputValue(), "https://example.org/suggested.git");
    await dialog.getByRole("button", { name: "Add project", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    const newCard = page.locator('[data-project-id="suggested-app"]'); await newCard.waitFor();
    assert.equal(await newCard.getAttribute("data-readiness"), "running");
    assert.match(await newCard.innerText(), /10%/);
    await page.evaluate(() => window.emitProjectSse("suggested-app", "agent.activity", { agent_id: "coder", activity_type: "progress", status: "working", summary: "Stage embedding: running" }));
    await page.waitForFunction(() => document.querySelector('[data-project-id="suggested-app"]')?.textContent?.includes("90%"));
    assert.match(await newCard.innerText(), /90%/);
  },

  "A ready card navigates from its non-button area to the matching project URL; running cards do not open a workspace; Edit and Delete controls do not trigger card navigation.": async ({ page, origin }) => {
    await openDirectory(page, origin);
    await page.locator('[data-project-id="alpha-running"] .project-card-body').click();
    assert.equal(await page.evaluate(() => window.location.pathname), "/");
    const betaCard = page.locator('[data-project-id="beta-ready"]');
    for (const btn of ["Edit Beta Ready", "Delete Beta Ready"]) {
      await betaCard.getByRole("button", { name: btn }).click();
      await page.getByRole("dialog").waitFor();
      assert.equal(await page.evaluate(() => window.location.pathname), "/");
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    }
    await betaCard.locator(".project-card-body").click();
    await page.waitForFunction(() => window.location.pathname === "/beta-ready");
  },

  "The Edit modal exposes and persists every approved editable project configuration field, including nested commands, default_agents and watch settings; Delete requires confirmation explicitly stating that project files are preserved and removes only the confirmed card.": async ({ page, origin }) => {
    await openDirectory(page, origin);
    const betaCard = page.locator('[data-project-id="beta-ready"]');
    await betaCard.getByRole("button", { name: "Edit Beta Ready" }).click();
    const editDialog = page.getByRole("dialog"); await editDialog.waitFor();
    const edits = [
      ["Project name", "Beta Updated"], ["Author", "New Owner"], ["Description", "Updated description"],
      ["Git URL", "https://example.org/beta-updated.git"], ["Default branch", "develop"], ["Default workflow ID", "WF-CUSTOM"],
      ["Language", "typescript"], ["Package manager", "npm"], ["Comment language", "vi"],
      ["Homepage URL", "https://updated.example.org"], ["Docs URL", "https://updated.example.org/docs"], ["Tags", "tag-a, tag-b"],
      ["Test command", "npm test"], ["Lint command", "npm run lint"], ["Build command", "npm run build"], ["Dev command", "npm run dev"],
      ["Architecture Manager agent", "am-updated"], ["Sprint Leader agent", "sl-updated"], ["Coder agent", "coder-updated"], ["Reviewer agent", "reviewer-updated"],
      ["Watch include", "src/**, app/**"], ["Watch exclude", "dist/**, .next/**"], ["Metadata (JSON)", '{"tier":"enterprise"}']
    ];
    for (const [label, value] of edits) await editDialog.getByLabel(label, { exact: true }).fill(value);
    await editDialog.getByRole("button", { name: "Save changes" }).click();
    await editDialog.waitFor({ state: "hidden" });
    const putCall = await page.evaluate(() => window.calls.findLast((c) => c.path === "/forge/v1/projects/beta-ready" && c.method === "PUT"));
    assert.equal(putCall.body.name, "Beta Updated"); assert.equal(putCall.body.comment_language, "vi");
    assert.deepEqual(putCall.body.commands, { test: "npm test", lint: "npm run lint", build: "npm run build", dev: "npm run dev" });
    assert.deepEqual(putCall.body.default_agents, { architecture_manager: "am-updated", sprint_leader: "sl-updated", coder: "coder-updated", reviewer: "reviewer-updated" });
    assert.deepEqual(putCall.body.watch, { include: ["src/**", "app/**"], exclude: ["dist/**", ".next/**"] });
    assert.deepEqual(putCall.body.tags, ["tag-a", "tag-b"]); assert.deepEqual(putCall.body.metadata, { tier: "enterprise" });
    await betaCard.getByRole("button", { name: "Delete Beta Updated" }).click();
    const deleteDialog = page.getByRole("dialog"); await deleteDialog.waitFor();
    assert.match(await deleteDialog.innerText(), /only removes it from the managed project list[\s\S]*preserved/i);
    await deleteDialog.getByRole("button", { name: "Confirm remove" }).click();
    await deleteDialog.waitFor({ state: "hidden" });
    assert.equal(await page.locator('[data-project-id="beta-ready"]').count(), 0);
    assert.equal(await page.locator('[data-project-id="alpha-running"]').count(), 1);
  },

  "Exact backend error codes and detailed messages from preflight, add, edit, delete and initialization/index failures remain visible in the relevant modal or project card without a success state hiding the failure.": async ({ page, origin }) => {
    await openDirectory(page, origin);
    await page.evaluate(() => { window.mock.addError = { code: "IDENTITY_CONFLICT", message: "Catalog and per-root project identity differ.", stage: "identity", status: 409 }; });
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    const addDialog = page.getByRole("dialog"); await addDialog.waitFor();
    await addDialog.getByLabel("Absolute server path").fill("/server/existing-app");
    await addDialog.locator('[data-preflight-status="existing"]').waitFor();
    await addDialog.getByRole("button", { name: "Add project", exact: true }).click();
    await addDialog.locator('[role="alert"]').filter({ hasText: "IDENTITY_CONFLICT" }).waitFor();
    assert.match(await addDialog.innerText(), /Catalog and per-root project identity differ/);
    await addDialog.getByRole("button", { name: "Cancel" }).click(); await addDialog.waitFor({ state: "hidden" });
    await page.evaluate(() => { window.mock.addError = null; window.mock.editError = { code: "CONFIGURATION_ERROR", message: "Cannot change existing root when updating project configuration.", status: 400 }; });
    const betaCard = page.locator('[data-project-id="beta-ready"]');
    await betaCard.getByRole("button", { name: "Edit Beta Ready" }).click();
    const editDialog = page.getByRole("dialog"); await editDialog.waitFor();
    await editDialog.getByRole("button", { name: "Save changes" }).click();
    await editDialog.locator('[role="alert"]').filter({ hasText: "CONFIGURATION_ERROR" }).waitFor();
    await editDialog.getByRole("button", { name: "Cancel" }).click(); await editDialog.waitFor({ state: "hidden" });
    await page.evaluate(() => { window.mock.editError = null; window.mock.deleteError = { code: "LIFECYCLE_CLEANUP_FAILED", message: "Active runtime handle refused shutdown.", status: 500 }; });
    await betaCard.getByRole("button", { name: "Delete Beta Ready" }).click();
    const deleteDialog = page.getByRole("dialog"); await deleteDialog.waitFor();
    await deleteDialog.getByRole("button", { name: "Confirm remove" }).click();
    await deleteDialog.locator('[role="alert"]').filter({ hasText: "LIFECYCLE_CLEANUP_FAILED" }).waitFor();
    await deleteDialog.getByRole("button", { name: "Cancel" }).click(); await deleteDialog.waitFor({ state: "hidden" });
    await page.evaluate(() => { window.mock.deleteError = null; });
    const alphaCard = page.locator('[data-project-id="alpha-running"]');
    await page.evaluate(() => window.emitProjectSse("alpha-running", "project.failed", { status: "failed", error: { code: "COMMENT_NORMALIZATION_FAILED", message: "Coder normalizer rejected mixed language comments in inventory.js." } }));
    await alphaCard.locator('[data-error="project"]').waitFor();
    assert.match(await alphaCard.innerText(), /COMMENT_NORMALIZATION_FAILED[\s\S]*Coder normalizer rejected mixed language comments/);
    assert.equal(await alphaCard.getAttribute("data-readiness"), "unavailable");
  },

  "Opening and switching between distinct slug and legacy project URLs scopes ArchitectureWorkspace history, conversations, agent selection, events and coding/system child screens to the current route projectId without requests or retained state leaking from the previous project.": async ({ page, origin }) => {
    await openDirectory(page, origin);
    await page.evaluate(() => window.navigateTo("/beta-ready"));
    await page.getByText("Welcome to beta-ready", { exact: true }).waitFor();
    await page.evaluate(() => window.emitProjectSse("PROJECT-LEGACY-99", "conversation.message.received", { conversation_id: "conv-beta-ready", message_id: "msg-leak", text: "LEAKED FROM LEGACY" }));
    assert.equal(await page.getByText("LEAKED FROM LEGACY").count(), 0);
    const mark = await page.evaluate(() => window.calls.length);
    await page.evaluate(() => window.navigateTo("/PROJECT-LEGACY-99"));
    await page.getByText("Welcome to PROJECT-LEGACY-99", { exact: true }).waitFor();
    assert.equal(await page.getByText("Welcome to beta-ready").count(), 0);
    const convCalls = await page.evaluate((start) => window.calls.slice(start).filter((c) => c.path.includes("/conversations")), mark);
    assert.ok(convCalls.length > 0 && convCalls.every((c) => (c.query.project ?? c.query.project_id) === "PROJECT-LEGACY-99"));
    await page.evaluate(() => window.navigateTo("/beta-ready/coding"));
    await page.getByText("SPRINT-beta-ready").waitFor();
    assert.equal(await page.getByText("SPRINT-PROJECT-LEGACY-99").count(), 0);
    await page.evaluate(() => window.navigateTo("/PROJECT-LEGACY-99/coding"));
    await page.getByText("SPRINT-PROJECT-LEGACY-99").waitFor();
    assert.equal(await page.getByText("SPRINT-beta-ready").count(), 0);
    await page.evaluate(() => window.navigateTo("/beta-ready/system"));
    await page.getByText("Welcome to beta-ready", { exact: true }).waitFor();
    await page.evaluate(() => window.navigateTo("/PROJECT-LEGACY-99/system"));
    await page.getByText("Welcome to PROJECT-LEGACY-99", { exact: true }).waitFor();
    assert.equal(await page.getByText("Welcome to beta-ready").count(), 0);
  }
};

// Allow focused verification to invoke the same Node-owned browser runner before committing.
if (process.argv[1]?.endsWith("project-lifecycle.browser.mjs")) {
  setImmediate(async () => {
    try {
      const { runBrowserVerification } = await import("../../../backend/src/modules/supervisor/browser-verification-runner.js");
      const receipt = await runBrowserVerification({ projectRoot: process.cwd(), sourceRoot: process.cwd(),
        step: { kind: "browser", scenario_path: "ui/nextjs/tests/project-lifecycle.browser.mjs", criterion_ids: ["AC-1"],
          viewports: [375, 768, 1440], assertions: Object.keys(browserAssertions) } });
      console.log(JSON.stringify(receipt));
    } catch (error) { console.error(error); process.exitCode = 1; }
  });
}
