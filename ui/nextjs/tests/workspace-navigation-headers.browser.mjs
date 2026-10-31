// Exercises Architecture, System, Coding, and Agents workspace navigation and shared page headers in Chromium.
// Business purpose: verifies O3 acceptance criteria across mobile, tablet, and desktop viewports using real bundled Next.js components against controlled HTTP and SSE boundaries.
// Technical description: exports `createBrowserFixture` and `browserAssertions` verifying Coding's shared page header and independent column scrolling, Agents' migration to `.claude-home-shell` with `ConversationSidebar` and full CRUD/test/toggle operations without project admission or Git status requests, and cross-page navigation and overflow invariants at 375/768/1440px.
import assert from "node:assert/strict";
import { join } from "node:path";

// Business purpose: compiles real Next.js Architecture, System, Coding, and Agents workspace pages into a self-contained browser bundle so Chromium assertions verify live shell headers, sidebar navigation, column scrolling, and agent management without mutating the production API.
// Technical description: bundles `ProjectPage`, `ProjectSystemPage`, `ProjectCodingPage`, `SystemPage`, `CodingPage`, `AgentsPage`, and `ProjectRouteBoundary` with controlled `fetch`, `EventSource`, and `confirm` handlers.
export async function createBrowserFixture({ sourceRoot, build }) {
  const navStub = [
    "import {createContext,useContext} from 'react';",
    "export const NavContext=createContext({pathname:'/PROJECT-ALPHA',params:{projectId:'PROJECT-ALPHA'},router:{push(){},replace(){}}});",
    "export const usePathname=()=>useContext(NavContext).pathname;",
    "export const useParams=()=>useContext(NavContext).params;",
    "export const useRouter=()=>useContext(NavContext).router;",
    "export const redirect=p=>{window.navigateTo?.(p);};"
  ].join("\n");
  const source = [
    "import React,{useEffect,useMemo,useState} from 'react';import {createRoot} from 'react-dom/client';",
    "import {NavContext} from 'next/navigation';",
    "import ProjectPage from './app/[projectId]/page.jsx';import ProjectSystemPage from './app/[projectId]/system/page.jsx';import ProjectCodingPage from './app/[projectId]/coding/page.jsx';",
    "import SystemPage from './app/system/page.jsx';import CodingPage from './app/coding/page.jsx';import AgentsPage from './app/agents/page.jsx';",
    "import {ProjectRouteBoundary} from './components/project-route-boundary.jsx';",
    "import * as selection from './lib/project-selection.js';import * as directory from './lib/project-directory-client.js';import * as navigation from './lib/project-navigation.js';",
    "import './app/globals.css';",
    "window.api={...selection,...directory,...navigation};window.calls=[];window.sources=[];window.fixtureErrors=[];window.confirm=()=>true;",
    "window.addEventListener('error',e=>window.fixtureErrors.push(e.error?.stack??e.message));",
    "window.addEventListener('unhandledrejection',e=>window.fixtureErrors.push(String(e.reason?.stack??e.reason)));",
    "window.projects=[{project_id:'PROJECT-ALPHA',name:'Alpha Catalog Name',root:'/srv/alpha',readiness:'ready'},{project_id:'PROJECT-BETA',name:'Beta Catalog Name',root:'/srv/beta',readiness:'ready'}];",
    "window.agents=[{agent_id:'am-1',agent_name:'Architect One',role:'architecture_manager',team:'Backend',enabled:true,status:'ready',provider:'anthropic',model:'claude-opus-4-6',reasoning:{effort:'medium'},tool_mode:'forge',gateway_url:'https://gw.test/am'},{agent_id:'se-1',agent_name:'System Eng One',role:'system_engineer',team:'Backend',enabled:true,status:'ready',provider:'codex',model:'gpt-5.3-codex',reasoning:{effort:'medium'},tool_mode:'forge',gateway_url:'https://gw.test/se'},{agent_id:'coder-1',agent_name:'Coder One',role:'coder',team:'Backend',enabled:true,status:'working',provider:'anthropic',model:'claude-sonnet-4-6',reasoning:{effort:'medium'},tool_mode:'forge',gateway_url:'https://gw.test/c1'},{agent_id:'coder-2',agent_name:'Coder Two',role:'coder',team:'Frontend',enabled:true,status:'working',provider:'codex',model:'gpt-5.3-codex',reasoning:{effort:'medium'},tool_mode:'forge',gateway_url:'https://gw.test/c2'},{agent_id:'rev-1',agent_name:'Reviewer One',role:'reviewer',team:'Security',enabled:true,status:'working',provider:'anthropic',model:'claude-sonnet-4-6',reasoning:{effort:'medium'},tool_mode:'forge',gateway_url:'https://gw.test/r1'}];",
    "window.gitByProject={'PROJECT-ALPHA':{state:'clean',branch:'main',changed_files:0},'PROJECT-BETA':{state:'dirty',branch:'feature/o3-shell',changed_files:2}};",
    "const sTickets=Array.from({length:18},(_,i)=>({id:'T-'+(i+1),ticket_id:'T-'+(i+1),title:'Ticket '+(i+1)+' implementation verification item with details',status:i%2===0?'IN_PROGRESS':'DONE',assigned_agent_id:'coder-1',verification_status:'PASSED'}));",
    "window.dashboardByProject={'PROJECT-ALPHA':{project_id:'PROJECT-ALPHA',sprints:[{id:'S-1',sprint_id:'S-1',name:'Sprint 1 Core Shell',status:'ACTIVE',tickets:sTickets.slice(0,9)},{id:'S-2',sprint_id:'S-2',name:'Sprint 2 Integration',status:'ACTIVE',tickets:sTickets.slice(9)}],roadmap:{id:'RM-1',version:'1',sprints:[{id:'S-1',sprint_id:'S-1',name:'Sprint 1 Core Shell',status:'ACTIVE',tickets:sTickets.slice(0,9)},{id:'S-2',sprint_id:'S-2',name:'Sprint 2 Integration',status:'ACTIVE',tickets:sTickets.slice(9)}]}}};",
    "window.fetch=async(input,init={})=>{const url=new URL(input,location.origin),method=init.method||'GET',body=init.body?JSON.parse(init.body):null;",
    "const project=url.searchParams.get('project')??url.searchParams.get('project_id')??body?.project_id??'PROJECT-ALPHA';",
    "window.calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method,body});",
    "if(url.pathname==='/model-catalog.json')return Response.json({providers:{anthropic:[{value:'claude-opus-4-6',label:'Claude Opus 4.6'},{value:'claude-sonnet-4-6',label:'Claude Sonnet 4.6'}],codex:[{value:'gpt-5.3-codex',label:'GPT-5.3 Codex'}],openai:[{value:'gpt-5',label:'GPT-5'}]}});",
    "if(url.pathname.endsWith('/lifecycle/list')||url.pathname==='/forge/v1/projects')return Response.json({projects:window.projects});",
    "if(url.pathname.endsWith('/agents')&&method==='GET'){const role=url.searchParams.get('role');return Response.json({agents:role?window.agents.filter(a=>a.role===role):window.agents});}",
    "if(url.pathname.endsWith('/agents')&&method==='POST'){const created={agent_id:'agent-new-'+window.agents.length,status:'ready',...body};window.agents=[...window.agents,created];return Response.json(created);}",
    "if(url.pathname.includes('/agents/')&&url.pathname.endsWith('/test')&&method==='POST'){const id=decodeURIComponent(url.pathname.split('/').slice(-2)[0]);const found=window.agents.find(a=>a.agent_id===id);return Response.json({ok:true,gateway_url:found?.gateway_url||'https://gw.test/ok'});}",
    "if(url.pathname.includes('/agents/')&&method==='PUT'){const id=decodeURIComponent(url.pathname.split('/').pop());let updated=null;window.agents=window.agents.map(a=>{if(a.agent_id!==id)return a;updated={...a,...body,agent_id:id};return updated;});return Response.json(updated||{agent_id:id,...body});}",
    "if(url.pathname.includes('/agents/')&&method==='DELETE'){const id=decodeURIComponent(url.pathname.split('/').pop());window.agents=window.agents.filter(a=>a.agent_id!==id);return Response.json({deleted:true,agent_id:id});}",
    "if(url.pathname.endsWith('/git/status'))return Response.json(window.gitByProject[project]||{state:'clean',branch:'main',changed_files:0});",
    "if(url.pathname.endsWith('/dashboard'))return Response.json(window.dashboardByProject[project]||window.dashboardByProject['PROJECT-ALPHA']);",
    "if(url.pathname.endsWith('/conversations')&&method==='GET')return Response.json({items:[{id:'conv-'+project,conversation_id:'conv-'+project,title:'Conv '+project,agent_id:url.searchParams.get('agent_id')||'am-1',project_id:project}]});",
    "if(url.pathname.includes('/conversations/')&&url.pathname.endsWith('/messages'))return Response.json({items:[]});",
    "if(url.pathname.includes('/plan-clarifications'))return Response.json([]);",
    "return Response.json({items:[],project_id:project});};",
    "window.EventSource=class{constructor(url){this.url=String(url);this.readyState=1;this.closed=false;this.listeners=new Map();window.sources.push(this);queueMicrotask(()=>this.onopen?.({}));}",
    "addEventListener(type,fn){const set=this.listeners.get(type)||new Set();set.add(fn);this.listeners.set(type,set);}",
    "emit(type,data){for(const fn of this.listeners.get(type)||[])fn({data:JSON.stringify(data),lastEventId:data.event_id});}",
    "emitCodingActivities(projectId){['coder-1','coder-2','rev-1'].forEach(agentId=>{for(let i=0;i<14;i++)this.emit('agent.activity',{schema_version:1,event_id:`ev-${agentId}-${i}-${Date.now()}`,event_type:'agent.activity',project_id:projectId,timestamp:'2026-10-30T10:00:00Z',payload:{agent_id:agentId,activity_type:'tool_call',status:'working',tool_name:'read_file',summary:`Step ${i+1} for ${agentId} inspecting module layout and responsive container track rules`}});});}",
    "close(){this.closed=true;this.readyState=2;}};",
    "window.emitCodingActivities=(projectId='PROJECT-ALPHA')=>window.sources.filter(s=>!s.closed&&s.url.includes('project='+projectId)).forEach(s=>s.emitCodingActivities(projectId));",
    "function FixtureApp(){const[pathname,setPathname]=useState(()=>window.location.pathname==='/'?'/PROJECT-ALPHA/coding':window.location.pathname);const[rev,setRev]=useState(0);",
    "useEffect(()=>{const onClick=e=>{const a=e.target.closest?.('a[href]');if(!a)return;const url=new URL(a.getAttribute('href'),location.origin);if(url.origin===location.origin){e.preventDefault();window.navigateTo(url.pathname);}};",
    "document.addEventListener('click',onClick);window.navigateTo=p=>{window.history.pushState({},'',p);setPathname(p);};window.rerenderFixture=()=>setRev(r=>r+1);return()=>document.removeEventListener('click',onClick);},[]);",
    "const segs=pathname.split('/').filter(Boolean);const isGlobal=['agents','system','coding','code'].includes(segs[0]);",
    "const nav=useMemo(()=>({pathname,params:(!isGlobal&&segs[0])?{projectId:decodeURIComponent(segs[0])}:{},router:{push:p=>window.navigateTo(p),replace:p=>window.navigateTo(p)}}),[pathname]);",
    "let view=<ProjectPage key={pathname+':'+rev}/>;if(pathname==='/')view=<main aria-label='Project directory'><h1>Projects Directory</h1></main>;",
    "else if(pathname==='/agents'||pathname.startsWith('/agents/'))view=<AgentsPage key={pathname+':'+rev}/>;",
    "else if(pathname==='/system')view=<SystemPage key={pathname+':'+rev}/>;else if(pathname==='/coding'||pathname==='/code')view=<CodingPage key={pathname+':'+rev}/>;",
    "else if(segs.length===2&&segs[1]==='system')view=<ProjectSystemPage key={pathname+':'+rev}/>;else if(segs.length===2&&segs[1]==='coding')view=<ProjectCodingPage key={pathname+':'+rev}/>;",
    "return <NavContext.Provider value={nav}><ProjectRouteBoundary>{view}</ProjectRouteBoundary></NavContext.Provider>;}",
    "createRoot(document.getElementById('root')).render(<FixtureApp/>);"
  ].join("\n");
  const compiled = await build({
    stdin: { contents: source, resolveDir: join(sourceRoot, "ui/nextjs"), loader: "jsx" },
    bundle: true, write: false, jsx: "automatic", outfile: "fixture.js",
    plugins: [{ name: "next-nav", setup(b) { b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next-nav", namespace: "ns" })); b.onLoad({ filter: /.*/, namespace: "ns" }, () => ({ contents: navStub, resolveDir: join(sourceRoot, "ui/nextjs"), loader: "js" })); } }],
    alias: { react: join(sourceRoot, "ui/nextjs/node_modules/react"), "react-dom": join(sourceRoot, "ui/nextjs/node_modules/react-dom") },
    define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_NODE_CONTROL_API_URL": '""', "process.env": "{}" }
  });
  return {
    html: '<!doctype html><html lang="vi"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    assets: Object.fromEntries(compiled.outputFiles.map((file) => [file.path.endsWith(".css") ? "/fixture.css" : "/fixture.js", file.text]))
  };
}

// Business purpose: navigates the Chromium test fixture to a requested route and waits for the shared sidebar and page header to mount.
// Technical description: calls `window.navigateTo(pathname)`, waits for `.conversation-sidebar` and `.claude-chat-header`, and closes floating system monitors when testing narrow header geometry.
async function openWorkspaceRoute(page, origin, pathname) {
  if (new URL(page.url()).origin !== origin) await page.goto(origin);
  await page.evaluate((target) => window.navigateTo(target), pathname);
  await page.locator(".conversation-sidebar").waitFor({ state: "attached" });
  await page.locator(".claude-chat-header").first().waitFor({ state: "attached" });
  for (const label of ["Close Watcher monitor", "Close Agent monitor"]) {
    const btn = page.locator(`button[aria-label="${label}"]`);
    if (await btn.count() > 0 && await btn.first().isVisible()) await btn.first().click();
  }
}

// Business purpose: ensures the sidebar navigation links are accessible on mobile viewports by opening the drawer when needed.
// Technical description: clicks the mobile rail open button when `viewport <= 640` and `.responsive-region--conversations` is closed.
async function ensureSidebarOpen(page, viewport) {
  if (viewport <= 640 && !(await page.evaluate(() => Boolean(document.querySelector(".responsive-region--conversations.is-open"))))) {
    await page.evaluate(() => document.querySelector('.conversation-mobile-rail button[aria-label="Open conversations sidebar"]')?.click());
    await page.waitForFunction(() => Boolean(document.querySelector(".responsive-region--conversations.is-open")));
  }
}

export const browserAssertions = {
  "Coding displays a common header above both columns with Coding or Code on the left and the current project and one GitStatusIndicator on the right, with no Git indicator in the Workspace Agent column header.": async ({ page, origin }) => {
    await openWorkspaceRoute(page, origin, "/PROJECT-ALPHA/coding");
    await page.waitForFunction(() => document.querySelector(".coding-workspace-header .workspace-git-status strong")?.textContent === "Clean");
    const layout = await page.evaluate(() => {
      const header = document.querySelector(".coding-workspace-monitor > .claude-chat-header");
      const sprintCol = document.querySelector(".coding-sprint-plan"), agentCol = document.querySelector(".coding-workspace-agent");
      const agentColHeader = agentCol?.querySelector(".coding-workspace-column-header");
      const titleEl = header?.querySelector("h1"), rightEl = header?.querySelector(".claude-chat-header-project");
      const hRect = header?.getBoundingClientRect(), sRect = sprintCol?.getBoundingClientRect(), aRect = agentCol?.getBoundingClientRect();
      const tRect = titleEl?.getBoundingClientRect(), rRect = rightEl?.getBoundingClientRect();
      return {
        titleText: titleEl?.textContent?.trim(), projectName: rightEl?.querySelector(".claude-chat-header-project-name")?.textContent?.trim(),
        totalGit: document.querySelectorAll(".workspace-git-status").length, headerGit: header?.querySelectorAll(".workspace-git-status").length ?? 0,
        agentHeaderGit: agentColHeader?.querySelectorAll(".workspace-git-status").length ?? -1,
        aboveSprint: Boolean(hRect && sRect && hRect.bottom <= sRect.top + 4), aboveAgent: Boolean(hRect && aRect && hRect.bottom <= aRect.top + 4),
        leftRight: Boolean(tRect && rRect && tRect.left < rRect.left)
      };
    });
    assert.ok(layout.titleText === "Coding" || layout.titleText === "Code");
    assert.deepEqual([layout.projectName, layout.headerGit, layout.totalGit, layout.agentHeaderGit, layout.aboveSprint, layout.aboveAgent, layout.leftRight], ["Alpha Catalog Name", 1, 1, 0, true, true, true]);
  },

  "Agents uses claude-home-shell and ConversationSidebar with an Agents page header, no legacy NodeForgeHeader, and no project identity or Git status in the header.": async ({ page, origin }) => {
    await openWorkspaceRoute(page, origin, "/agents");
    const info = await page.evaluate(() => {
      const shell = document.querySelector(".claude-home-shell.agents-workspace-shell");
      const header = shell?.querySelector(".claude-chat-header"), main = shell?.querySelector("main.agents-directory");
      const hRect = header?.getBoundingClientRect(), mRect = main?.getBoundingClientRect();
      return {
        hasShell: Boolean(shell), hasSidebar: Boolean(shell?.querySelector(".conversation-sidebar")),
        legacyTopbarCount: document.querySelectorAll(".topbar").length, headerTitle: header?.querySelector("h1")?.textContent?.trim(),
        headerProjectCount: header?.querySelectorAll(".claude-chat-header-project, .home-plan-approval-project, .project-label").length ?? -1,
        headerGitCount: header?.querySelectorAll(".workspace-git-status").length ?? -1, totalGitCount: document.querySelectorAll(".workspace-git-status").length,
        headerAboveMain: Boolean(hRect && mRect && hRect.bottom <= mRect.top + 4)
      };
    });
    assert.deepEqual([info.hasShell, info.hasSidebar, info.legacyTopbarCount, info.headerTitle, info.headerProjectCount, info.headerGitCount, info.totalGitCount, info.headerAboveMain], [true, true, 0, "Agents", 0, 0, 0, true]);
  },

  "Agents preserves agent count, stream connection status, agent cards, add, edit, delete, enable and disable, and connection testing through real UI interactions.": async ({ page, origin }) => {
    await openWorkspaceRoute(page, origin, "/agents");
    await page.waitForFunction(() => document.querySelector(".agents-heading-actions")?.textContent?.includes("agents"));
    const initialCount = await page.evaluate(() => window.agents.length);
    assert.match(await page.locator(".agents-heading-actions").textContent(), new RegExp(`${initialCount} agents`));
    assert.match(await page.locator(".agents-heading-actions").textContent(), /live/);
    assert.equal(await page.locator(".agent-directory-card.agent-card-editable").count(), initialCount);

    await page.locator('button[aria-label="Add agent"]').click();
    const modal = page.locator(".agent-modal");
    await modal.waitFor({ state: "visible" });
    await modal.locator('input[name="agent_name"]').fill("Added Browser Agent");
    await modal.locator('input[name="gateway_url"]').fill("https://gw.test/added");
    await modal.locator('button[type="submit"]').click();
    await page.waitForFunction((expected) => document.querySelectorAll(".agent-directory-card.agent-card-editable").length === expected, initialCount + 1);
    assert.match(await page.locator(".agents-heading-actions").textContent(), new RegExp(`${initialCount + 1} agents`));

    const addedCard = page.locator('.agent-directory-card.agent-card-editable[aria-label="Edit Added Browser Agent"]');
    await addedCard.waitFor({ state: "visible" });
    const toggleBtn = addedCard.locator('button[aria-label="Toggle agent"]');
    const wasOn = await toggleBtn.evaluate((el) => el.classList.contains("is-on"));
    await toggleBtn.click();
    await page.waitForFunction(({ name, expected }) => document.querySelector(`.agent-directory-card.agent-card-editable[aria-label="Edit ${name}"] button[aria-label="Toggle agent"]`)?.classList.contains("is-on") === expected, { name: "Added Browser Agent", expected: !wasOn });

    await addedCard.locator("button.card-action-button", { hasText: "Test" }).click();
    const connModal = page.locator(".connection-result-modal");
    await connModal.waitFor({ state: "visible" });
    assert.match(await connModal.textContent(), /Connected/);
    await connModal.locator("button", { hasText: "Close" }).click();
    await connModal.waitFor({ state: "hidden" });

    await addedCard.click();
    await modal.waitFor({ state: "visible" });
    await modal.locator('input[name="agent_name"]').fill("Edited Browser Agent");
    await modal.locator('button[type="submit"]').click();
    const editedCard = page.locator('.agent-directory-card.agent-card-editable[aria-label="Edit Edited Browser Agent"]');
    await editedCard.waitFor({ state: "visible" });

    await editedCard.locator("button.card-action-button.danger", { hasText: "Delete" }).click();
    const delModal = page.locator(".agent-delete-modal");
    await delModal.waitFor({ state: "visible" });
    await delModal.locator("button.danger", { hasText: "Delete agent" }).click();
    await page.waitForFunction((expected) => document.querySelectorAll(".agent-directory-card.agent-card-editable").length === expected, initialCount);
  },

  "Coding Sprint Plan and Workspace Agent columns scroll independently beneath the common header and retain responsive layout and operable monitor controls.": async ({ page, viewport, origin }) => {
    await openWorkspaceRoute(page, origin, "/PROJECT-ALPHA/coding");
    await page.waitForFunction(() => window.calls.some((c) => c.path.endsWith("/agents") && c.method === "GET"));
    await page.evaluate(() => window.emitCodingActivities("PROJECT-ALPHA"));
    await page.waitForFunction(() => document.querySelectorAll(".coding-agent-monitor").length >= 3);
    const scrollCheck = await page.evaluate((vw) => {
      const monitor = document.querySelector(".coding-workspace-monitor"), header = monitor.querySelector(".coding-workspace-header");
      const sprint = document.querySelector(".coding-sprint-plan"), agent = document.querySelector(".coding-workspace-agent");
      for (const [col, cls] of [[sprint, "s-fill"], [agent, "a-fill"]]) if (!col.querySelector("." + cls)) for (let i = 0; i < 40; i++) { const p = document.createElement("p"); p.className = cls; p.textContent = "Filler " + i; col.append(p); }
      sprint.scrollTop = 0; agent.scrollTop = 0; const hBefore = header.getBoundingClientRect().top;
      sprint.scrollTop = 180; const sprintScrolled = sprint.scrollTop > 0 && agent.scrollTop === 0;
      sprint.scrollTop = 0; agent.scrollTop = 180; const agentScrolled = agent.scrollTop > 0 && sprint.scrollTop === 0;
      const hAfter = header.getBoundingClientRect().top, monitorCols = getComputedStyle(monitor).gridTemplateColumns.trim().split(/\s+/).length;
      return { sprintScrolled, agentScrolled, headerPinned: Math.abs(hBefore - hAfter) < 2, monitorCols, expectedCols: vw <= 760 ? 1 : 2 };
    }, viewport);
    assert.deepEqual([scrollCheck.sprintScrolled, scrollCheck.agentScrolled, scrollCheck.headerPinned, scrollCheck.monitorCols], [true, true, true, scrollCheck.expectedCols]);

    await page.locator('.coding-agent-monitor[data-agent-id="coder-1"] button[aria-label="Minimize agent panel coder-1"]').click();
    assert.equal(await page.locator('.coding-agent-monitor[data-agent-id="coder-1"].is-minimized').count(), 1);
    await page.locator('.coding-agent-monitor[data-agent-id="coder-1"] button[aria-label="Expand agent panel coder-1"]').click();
    assert.equal(await page.locator('.coding-agent-monitor[data-agent-id="coder-1"].is-minimized').count(), 0);
  },

  "Opening and operating Agents without a selected project uses the existing agents endpoint, makes no project-admission or Git status requests, hides conversation controls and preserves remembered project links.": async ({ page, viewport, origin }) => {
    if (new URL(page.url()).origin !== origin) await page.goto(origin);
    await page.evaluate(() => {
      window.navigateTo("/");
      window.sessionStorage.removeItem("nodeforge:selected-project");
      window.api.clearProjectSelection(); window.calls = []; window.navigateTo("/agents");
    });
    await page.locator(".agents-workspace-shell .conversation-sidebar").waitFor({ state: "attached" });
    await page.waitForFunction(() => window.calls.some((c) => c.path.endsWith("/agents") && c.method === "GET"));
    const checkNoProject = await page.evaluate(() => ({
      agentsCalls: window.calls.filter((c) => c.path.endsWith("/agents")).length,
      admissionCalls: window.calls.filter((c) => c.path.endsWith("/lifecycle/list") || c.path === "/forge/v1/projects").length,
      gitCalls: window.calls.filter((c) => c.path.endsWith("/git/status")).length,
      convControls: document.querySelectorAll(".claude-sidebar-architecture, .conversations-accordion, .claude-sidebar-navigation button[title='New conversation']").length
    }));
    assert.ok(checkNoProject.agentsCalls >= 1);
    assert.deepEqual([checkNoProject.admissionCalls, checkNoProject.gitCalls, checkNoProject.convControls], [0, 0, 0]);

    await page.evaluate(() => { window.api.rememberSelectedProject("PROJECT-BETA"); window.rerenderFixture(); });
    await ensureSidebarOpen(page, viewport);
    assert.equal(await page.locator('.claude-sidebar-navigation a[title="Architecture"]').getAttribute("href"), "/PROJECT-BETA");
    assert.equal(await page.locator('.claude-sidebar-navigation a[title="System"]').getAttribute("href"), "/PROJECT-BETA/system");
    assert.equal(await page.locator('.claude-sidebar-navigation a[title="Code"]').getAttribute("href"), "/PROJECT-BETA/coding");
  },

  "Architecture, System, Coding and Agents all omit Projects, expose the correct current navigation link and approved conversation controls, and handle long header content without horizontal page overflow.": async ({ page, viewport, origin }) => {
    await page.evaluate(() => {
      const longTitle = "Very-Long-Unbroken-Header-Title-Segment-To-Verify-Responsive-Ellipsis-And-Zero-Horizontal-Overflow-Across-All-Four-Pages";
      window.projects = window.projects.map((p) => p.project_id === "PROJECT-ALPHA" ? { ...p, name: longTitle } : p);
      window.api.syncProjectsToSelection(window.projects);
      window.gitByProject["PROJECT-ALPHA"] = { state: "dirty", branch: "feature/very-long-git-branch-name-across-all-four-workspace-pages", changed_files: 9 };
    });
    for (const [route, current, hasConv] of [["/PROJECT-ALPHA", "Architecture", true], ["/PROJECT-ALPHA/system", "System", true], ["/PROJECT-ALPHA/coding", "Code", false], ["/agents", "Agents", false]]) {
      await openWorkspaceRoute(page, origin, route);
      await ensureSidebarOpen(page, viewport);
      assert.equal(await page.locator(".claude-sidebar-projects, .claude-sidebar-project-list, .claude-sidebar-project-link").count(), 0);
      assert.equal(await page.locator(`.claude-sidebar-navigation a[title="${current}"]`).getAttribute("aria-current"), "page");
      assert.equal(await page.locator(".claude-sidebar-architecture").count(), hasConv ? 1 : 0);
      assert.equal(await page.locator('.claude-sidebar-navigation button[title="New conversation"]').count(), hasConv ? 1 : 0);
      if (viewport <= 640) await page.evaluate(() => document.querySelector(".conversation-sidebar button.home-sidebar-collapse")?.click());
      const noOverflow = await page.evaluate((vw) => {
        const rect = document.querySelector(".claude-chat-header")?.getBoundingClientRect();
        return document.documentElement.scrollWidth <= window.innerWidth + 1 && Boolean(rect && rect.left >= -1 && rect.right <= vw + 1);
      }, viewport);
      assert.equal(noOverflow, true, `no horizontal overflow on ${route} at ${viewport}px`);
    }
  }
};

// Allow focused verification to invoke the same Node-owned browser runner before committing.
if (process.argv[1]?.endsWith("workspace-navigation-headers.browser.mjs")) {
  setImmediate(async () => {
    try {
      const { runBrowserVerification } = await import("../../../backend/src/modules/supervisor/browser/browser-verification-runner.js");
      const receipt = await runBrowserVerification({ projectRoot: process.cwd(), sourceRoot: process.cwd(),
        step: { kind: "browser", scenario_path: "ui/nextjs/tests/workspace-navigation-headers.browser.mjs", criterion_ids: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7", "AC-8", "AC-9", "AC-10", "AC-11"],
          viewports: [375, 768, 1440], assertions: Object.keys(browserAssertions) } });
      console.log(JSON.stringify(receipt));
    } catch (error) { console.error(error); process.exitCode = 1; }
  });
}
