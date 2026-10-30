// Exercises ConversationSidebar across Architecture, System, Coding, and Agents contexts in Chromium.
// Business purpose: verifies O1 acceptance criteria across mobile, tablet, and desktop viewports using real bundled Next.js sidebar and workspace components against controlled HTTP and SSE boundaries.
// Technical description: exports `createBrowserFixture` and `browserAssertions` verifying removal of `.claude-sidebar-projects`, presence of the NodeForge `/` brand link, operable sidebar collapse/open controls, `ThemeToggle`, `aria-current="page"` across all 4 navigation links, conditional conversation controls (`ConversationsAccordion`, agent selector, `New conversation`), remount-surviving sidebar collapse preference, and preserved project identity across `/agents`.
import assert from "node:assert/strict";
import { join } from "node:path";

// Business purpose: compiles real Next.js sidebar and workspace components into a self-contained browser bundle so Chromium assertions verify live navigation, conversation controls, and preference persistence without touching the production API.
// Technical description: bundles `ArchitectureWorkspace`, `SystemPage`, `CodingPage`, `ConversationSidebar`, `ConversationsAccordion`, `ProjectWorkspace`, and project navigation helpers with controlled `fetch` and `EventSource` stubs.
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
    "import SystemPage from './app/system/page.jsx';import CodingPage from './app/coding/page.jsx';",
    "import {ConversationSidebar} from './components/conversation-sidebar.jsx';import {ConversationsAccordion} from './components/ConversationsAccordion.jsx';",
    "import {ProjectRouteBoundary} from './components/project-route-boundary.jsx';",
    "import * as selection from './lib/project-selection.js';import * as navigation from './lib/project-navigation.js';import * as preference from './lib/sidebar-preference.js';",
    "import './app/globals.css';",
    "window.api={...selection,...navigation,...preference};window.calls=[];window.sources=[];window.fixtureErrors=[];",
    "window.addEventListener('error',e=>window.fixtureErrors.push(e.error?.stack??e.message));",
    "window.addEventListener('unhandledrejection',e=>window.fixtureErrors.push(String(e.reason?.stack??e.reason)));",
    "const projects=[{project_id:'PROJECT-ALPHA',name:'Alpha Project',root:'/srv/alpha',readiness:'ready'},{project_id:'PROJECT-BETA',name:'Beta Project',root:'/srv/beta',readiness:'ready'}];",
    "const agents=[{agent_id:'am-1',agent_name:'Architect One',role:'architecture_manager',enabled:true},{agent_id:'se-1',agent_name:'System Eng One',role:'system_engineer',enabled:true},{agent_id:'coder-1',agent_name:'Coder One',role:'coder',enabled:true,status:'ready'}];",
    "window.fetch=async(input,init={})=>{const url=new URL(input,location.origin),method=init.method||'GET',body=init.body?JSON.parse(init.body):null;",
    "const project=url.searchParams.get('project')??url.searchParams.get('project_id')??body?.project_id??'PROJECT-ALPHA';",
    "window.calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method,body});",
    "if(url.pathname.endsWith('/lifecycle/list')||url.pathname==='/forge/v1/projects')return Response.json({projects});",
    "if(url.pathname.endsWith('/agents')){const role=url.searchParams.get('role');return Response.json({agents:role?agents.filter(a=>a.role===role):agents});}",
    "if(url.pathname.endsWith('/conversations')&&method==='GET')return Response.json({items:[{id:'conv-'+project,conversation_id:'conv-'+project,title:'Conversation '+project,agent_id:url.searchParams.get('agent_id')||'am-1',project_id:project}]});",
    "if(url.pathname.includes('/conversations/')&&url.pathname.endsWith('/messages'))return Response.json({items:[{id:'msg-'+project,kind:'agent',agent_id:'am-1',conversation_id:'conv-'+project,timestamp:'2026-10-30T00:00:00Z',content:{text:'Ready in '+project,content_type:'text/plain'}}]});",
    "if(url.pathname.endsWith('/dashboard'))return Response.json({project_id:project,roadmap:{id:'RM-1',version:'1',sprints:[]}});",
    "if(url.pathname.endsWith('/git/status'))return Response.json({branch:'main',clean:true,files:[]});",
    "if(url.pathname.endsWith('/plan-clarifications'))return Response.json([]);",
    "return Response.json({items:[],project_id:project});};",
    "window.EventSource=class{constructor(url){this.url=String(url);this.readyState=1;this.closed=false;window.sources.push(this);queueMicrotask(()=>this.onopen?.({}));}addEventListener(){}close(){this.closed=true;this.readyState=2;}};",
    "function AgentsSidebarHost(){const[open,setOpen]=useState(false);return <div className='claude-home-shell agents-workspace-shell' data-route-context='agents'><ConversationSidebar open={open} onOpen={()=>setOpen(true)} onClose={()=>setOpen(false)} agentSectionTitle='Agents' showConversationControls={false}><ConversationsAccordion conversations={[{id:'leaked-conv',title:'Leaked conversation'}]}/></ConversationSidebar><main className='claude-home-main' aria-label='Agents directory'><h1>Agents</h1></main></div>;}",
    "function FixtureApp(){const[pathname,setPathname]=useState(()=>window.location.pathname==='/'?'/PROJECT-ALPHA':window.location.pathname);const[mountKey,setMountKey]=useState(0);",
    "useEffect(()=>{const onClick=e=>{const a=e.target.closest?.('a[href]');if(!a)return;const url=new URL(a.getAttribute('href'),location.origin);if(url.origin===location.origin){e.preventDefault();window.navigateTo(url.pathname);}};",
    "document.addEventListener('click',onClick);window.navigateTo=p=>{window.history.pushState({},'',p);setPathname(p);};window.remountSidebar=()=>setMountKey(k=>k+1);return()=>document.removeEventListener('click',onClick);},[]);",
    "const segs=pathname.split('/').filter(Boolean);const isGlobal=['agents','system','coding','code'].includes(segs[0]);",
    "const nav=useMemo(()=>({pathname,params:(!isGlobal&&segs[0])?{projectId:decodeURIComponent(segs[0])}:{},router:{push:p=>window.navigateTo(p),replace:p=>window.navigateTo(p)}}),[pathname]);",
    "let view=<ProjectPage/>;if(pathname==='/')view=<main aria-label='Project directory'><h1>Projects Directory</h1></main>;",
    "else if(pathname==='/agents'||pathname.startsWith('/agents/'))view=<AgentsSidebarHost/>;",
    "else if(pathname==='/system')view=<SystemPage/>;else if(pathname==='/coding'||pathname==='/code')view=<CodingPage/>;",
    "else if(segs.length===2&&segs[1]==='system')view=<ProjectSystemPage/>;else if(segs.length===2&&segs[1]==='coding')view=<ProjectCodingPage/>;",
    "return <NavContext.Provider value={nav}><div key={mountKey}><ProjectRouteBoundary>{view}</ProjectRouteBoundary></div></NavContext.Provider>;}",
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

// Business purpose: navigates the Chromium test fixture to a requested route context and waits for the shared sidebar to mount.
// Technical description: invokes `window.navigateTo(pathname)` after loading `origin` and waits until `.conversation-sidebar` is present in the DOM.
async function openRoute(page, origin, pathname) {
  if (new URL(page.url()).origin !== origin) await page.goto(origin);
  await page.evaluate((target) => window.navigateTo(target), pathname);
  await page.locator(".conversation-sidebar").waitFor({ state: "attached" });
}

// Business purpose: ensures the sidebar is expanded and visible on narrow mobile viewports so controls and links can be inspected.
// Technical description: opens the responsive conversation drawer via the mobile rail control when the viewport is at or below 640px and the drawer is closed, without overwriting stored collapse preferences if the sidebar was intentionally collapsed before remount.
async function ensureSidebarAccessible(page, viewport) {
  if (viewport <= 640) {
    const drawerOpen = await page.evaluate(() => Boolean(document.querySelector(".responsive-region--conversations.is-open")));
    if (!drawerOpen) {
      await page.evaluate(() => document.querySelector('.conversation-mobile-rail button[aria-label="Open conversations sidebar"]')?.click());
      await page.waitForFunction(() => Boolean(document.querySelector(".responsive-region--conversations.is-open")));
    }
  }
}

export const browserAssertions = {
  "The real ConversationSidebar renders no Projects block in Architecture, System, Coding and Agents contexts.": async ({ page, origin }) => {
    for (const route of ["/PROJECT-ALPHA", "/PROJECT-ALPHA/system", "/PROJECT-ALPHA/coding", "/agents"]) {
      await openRoute(page, origin, route);
      assert.equal(await page.locator(".claude-sidebar-projects").count(), 0, `no .claude-sidebar-projects on ${route}`);
      assert.equal(await page.locator(".claude-sidebar-project-list").count(), 0, `no .claude-sidebar-project-list on ${route}`);
      assert.equal(await page.locator(".claude-sidebar-project-link").count(), 0, `no .claude-sidebar-project-link on ${route}`);
      assert.equal(await page.locator('.claude-sidebar-navigation summary[title="Projects"]').count(), 0, `no Projects summary on ${route}`);
    }
  },

  "Each route context exposes the NodeForge link to /, operable sidebar controls and ThemeToggle, and exactly the appropriate navigation link has aria-current=page.": async ({ page, viewport, origin }) => {
    const contexts = [
      { route: "/PROJECT-ALPHA", expectedCurrent: "Architecture" },
      { route: "/agents", expectedCurrent: "Agents" },
      { route: "/PROJECT-ALPHA/system", expectedCurrent: "System" },
      { route: "/PROJECT-ALPHA/coding", expectedCurrent: "Code" }
    ];
    for (const { route, expectedCurrent } of contexts) {
      await openRoute(page, origin, route);
      await ensureSidebarAccessible(page, viewport);
      const sidebar = page.locator(".conversation-sidebar");
      const brandLink = sidebar.locator("a.home-sidebar-wordmark");
      assert.equal(await brandLink.getAttribute("href"), "/");
      assert.match(await brandLink.textContent(), /NodeForge/);
      assert.equal(await sidebar.locator(".home-sidebar-controls .theme-toggle").count(), 1);
      assert.equal(await sidebar.locator("button.home-sidebar-collapse").count(), 1);

      const navLinks = sidebar.locator('.claude-sidebar-navigation > a[title]');
      assert.equal(await navLinks.count(), 4);
      const titles = await navLinks.evaluateAll((els) => els.map((el) => ({ title: el.getAttribute("title"), current: el.getAttribute("aria-current") })));
      assert.deepEqual(titles.map((item) => item.title), ["Architecture", "Agents", "System", "Code"]);
      const activeItems = titles.filter((item) => item.current === "page");
      assert.deepEqual(activeItems, [{ title: expectedCurrent, current: "page" }]);
    }

    await openRoute(page, origin, "/PROJECT-ALPHA");
    await ensureSidebarAccessible(page, viewport);
    const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.evaluate(() => document.querySelector(".conversation-sidebar .home-sidebar-controls .theme-toggle")?.click());
    await page.waitForFunction((prev) => document.documentElement.dataset.theme !== prev, initialTheme);
    const toggledTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    assert.notEqual(toggledTheme, initialTheme);

    await page.evaluate(() => document.querySelector(".conversation-sidebar button.home-sidebar-collapse")?.click());
    await page.waitForFunction(() => document.querySelector(".conversation-sidebar")?.classList.contains("is-collapsed") === true);
    if (viewport <= 640) {
      await page.evaluate(() => document.querySelector('.conversation-mobile-rail button[aria-label="Open conversations sidebar"]')?.click());
    } else {
      await page.evaluate(() => document.querySelector(".conversation-sidebar button.home-sidebar-collapse")?.click());
    }
    await page.waitForFunction(() => document.querySelector(".conversation-sidebar")?.classList.contains("is-collapsed") === false);
  },

  "Architecture and System expose agent selection, New conversation and ConversationsAccordion; Coding and Agents expose no conversation controls.": async ({ page, viewport, origin }) => {
    for (const route of ["/PROJECT-ALPHA", "/PROJECT-ALPHA/system"]) {
      await openRoute(page, origin, route);
      await ensureSidebarAccessible(page, viewport);
      await page.waitForFunction(() => document.querySelectorAll(".claude-architecture-list [role='option']").length > 0);
      assert.equal(await page.locator(".claude-sidebar-architecture").count(), 1, `agent selector in ${route}`);
      assert.equal(await page.locator('.claude-sidebar-navigation button[title="New conversation"]').count(), 1, `New conversation button in ${route}`);
      assert.equal(await page.locator(".conversations-accordion").count(), 1, `ConversationsAccordion in ${route}`);
      assert.equal(await page.locator('.conversation-mobile-rail button[aria-label="New chat"]').count(), 1, `mobile New chat button in ${route}`);
    }

    for (const route of ["/PROJECT-ALPHA/coding", "/agents"]) {
      await openRoute(page, origin, route);
      await ensureSidebarAccessible(page, viewport);
      assert.equal(await page.locator(".claude-sidebar-architecture").count(), 0, `no agent selector in ${route}`);
      assert.equal(await page.locator('.claude-sidebar-navigation button[title="New conversation"]').count(), 0, `no New conversation in ${route}`);
      assert.equal(await page.locator(".conversations-accordion").count(), 0, `no ConversationsAccordion in ${route}`);
      assert.equal(await page.locator('.conversation-mobile-rail button[aria-label="New chat"]').count(), 0, `no mobile New chat button in ${route}`);
    }
  },

  "Collapsing and reopening the sidebar survives remount, and navigation through Agents preserves route-project precedence and remembered project identity.": async ({ page, viewport, origin }) => {
    await openRoute(page, origin, "/PROJECT-ALPHA");
    await page.evaluate(() => { window.localStorage.removeItem("nodeforge.sidebar.collapsed"); window.remountSidebar(); });
    await page.waitForFunction(() => document.querySelector(".conversation-sidebar") && !document.querySelector(".conversation-sidebar").classList.contains("is-collapsed"));
    await ensureSidebarAccessible(page, viewport);

    await page.evaluate(() => document.querySelector(".conversation-sidebar button.home-sidebar-collapse")?.click());
    assert.equal(await page.evaluate(() => window.localStorage.getItem("nodeforge.sidebar.collapsed")), "true");
    await page.evaluate(() => window.remountSidebar());
    await page.waitForFunction(() => document.querySelector(".conversation-sidebar")?.classList.contains("is-collapsed") === true);

    if (viewport <= 640) {
      await page.evaluate(() => document.querySelector('.conversation-mobile-rail button[aria-label="Open conversations sidebar"]')?.click());
    } else {
      await page.evaluate(() => document.querySelector(".conversation-sidebar button.home-sidebar-collapse")?.click());
    }
    await page.waitForFunction(() => window.localStorage.getItem("nodeforge.sidebar.collapsed") === "false");
    assert.equal(await page.evaluate(() => window.localStorage.getItem("nodeforge.sidebar.collapsed")), "false");
    await page.evaluate(() => window.remountSidebar());
    await page.waitForFunction(() => document.querySelector(".conversation-sidebar") && !document.querySelector(".conversation-sidebar").classList.contains("is-collapsed"));

    await openRoute(page, origin, "/PROJECT-BETA");
    await page.waitForFunction(() => window.sessionStorage.getItem("nodeforge:selected-project") === "PROJECT-BETA");
    await ensureSidebarAccessible(page, viewport);

    await page.evaluate(() => document.querySelector('.claude-sidebar-navigation a[title="Agents"]')?.click());
    await page.waitForFunction(() => window.location.pathname === "/agents");
    await ensureSidebarAccessible(page, viewport);
    assert.equal(await page.locator('.claude-sidebar-navigation a[title="Agents"]').getAttribute("aria-current"), "page");
    assert.equal(await page.locator('.claude-sidebar-navigation a[title="Architecture"]').getAttribute("href"), "/PROJECT-BETA");
    assert.equal(await page.locator('.claude-sidebar-navigation a[title="System"]').getAttribute("href"), "/PROJECT-BETA/system");
    assert.equal(await page.locator('.claude-sidebar-navigation a[title="Code"]').getAttribute("href"), "/PROJECT-BETA/coding");

    await page.evaluate(() => { window.api.clearProjectSelection(); window.remountSidebar(); });
    await page.locator(".conversation-sidebar").waitFor({ state: "attached" });
    await ensureSidebarAccessible(page, viewport);
    assert.equal(await page.locator('.claude-sidebar-navigation a[title="Architecture"]').getAttribute("href"), "/PROJECT-BETA");
    assert.equal(await page.locator('.claude-sidebar-navigation a[title="System"]').getAttribute("href"), "/PROJECT-BETA/system");
    assert.equal(await page.locator('.claude-sidebar-navigation a[title="Code"]').getAttribute("href"), "/PROJECT-BETA/coding");

    await openRoute(page, origin, "/PROJECT-ALPHA/system");
    await page.waitForFunction(() => document.querySelector('.claude-sidebar-navigation a[title="Architecture"]')?.getAttribute("href") === "/PROJECT-ALPHA");
    assert.equal(await page.locator('.claude-sidebar-navigation a[title="System"]').getAttribute("href"), "/PROJECT-ALPHA/system");
    assert.equal(await page.locator('.claude-sidebar-navigation a[title="Code"]').getAttribute("href"), "/PROJECT-ALPHA/coding");
  }
};

// Allow focused verification to invoke the same Node-owned browser runner before committing.
if (process.argv[1]?.endsWith("conversation-sidebar-navigation.browser.mjs")) {
  setImmediate(async () => {
    try {
      const { runBrowserVerification } = await import("../../../backend/src/modules/supervisor/browser/browser-verification-runner.js");
      const receipt = await runBrowserVerification({ projectRoot: process.cwd(), sourceRoot: process.cwd(),
        step: { kind: "browser", scenario_path: "ui/nextjs/tests/conversation-sidebar-navigation.browser.mjs", criterion_ids: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7", "AC-8"],
          viewports: [375, 768, 1440], assertions: Object.keys(browserAssertions) } });
      console.log(JSON.stringify(receipt));
    } catch (error) { console.error(error); process.exitCode = 1; }
  });
}
