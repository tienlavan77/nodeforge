// Exercises ArchitectureWorkspace and SystemPage conversation headers, Git status, Settings, and workflows in Chromium.
// Business purpose: verifies O2 acceptance criteria across mobile, tablet, and desktop viewports using real bundled Next.js components against controlled HTTP and SSE boundaries.
// Technical description: exports `createBrowserFixture` and `browserAssertions` verifying two-sided `.claude-chat-header` layout, project catalog/fallback identity and Git status operations, removal of duplicate ProjectContext in `SystemToolMode` with operable agent Settings, responsive header overflow constraints at 375/768/1440px, and preserved conversation, clarification, and monitor panel workflows.
import assert from "node:assert/strict";
import { join } from "node:path";

// Business purpose: compiles real Next.js Architecture and System workspace pages into a self-contained browser bundle so Chromium assertions verify live header layout, Git interactions, Settings controls, and conversation workflows without mutating the production API.
// Technical description: bundles `ArchitectureWorkspace`, `SystemPage`, `ProjectRouteBoundary`, and project stores with controlled `fetch`, `EventSource`, and `confirm` handlers.
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
    "import ProjectPage from './app/[projectId]/page.jsx';import ProjectSystemPage from './app/[projectId]/system/page.jsx';",
    "import ArchitectureWorkspace from './components/architecture-workspace.jsx';import SystemPage from './app/system/page.jsx';",
    "import {ProjectRouteBoundary} from './components/project-route-boundary.jsx';",
    "import * as selection from './lib/project-selection.js';import * as directory from './lib/project-directory-client.js';",
    "import './app/globals.css';",
    "window.api={...selection,...directory};window.calls=[];window.sources=[];window.fixtureErrors=[];window.confirmCalls=[];",
    "window.addEventListener('error',e=>window.fixtureErrors.push(e.error?.stack??e.message));",
    "window.addEventListener('unhandledrejection',e=>window.fixtureErrors.push(String(e.reason?.stack??e.reason)));",
    "window.confirm=msg=>{window.confirmCalls.push(msg);return true;};",
    "window.projects=[{project_id:'PROJECT-ALPHA',name:'Alpha Catalog Name',root:'/srv/alpha',readiness:'ready'},{project_id:'PROJECT-BETA',name:'Beta Catalog Name',root:'/srv/beta',readiness:'ready'},{project_id:'PROJECT-FALLBACK-ID',root:'/srv/fallback',readiness:'ready'}];",
    "window.agents=[{agent_id:'am-1',agent_name:'Architect One',role:'architecture_manager',enabled:true,provider:'codex',model:'gpt-5.3-codex',reasoning:{effort:'medium'},tool_mode:'forge'},{agent_id:'se-1',agent_name:'System Eng One',role:'system_engineer',enabled:true,provider:'codex',model:'gpt-5.3-codex',reasoning:{effort:'medium'},tool_mode:'forge'}];",
    "window.gitByProject={'PROJECT-ALPHA':{state:'clean',branch:'main',changed_files:0},'PROJECT-BETA':{state:'dirty',branch:'feature/o2-header',changed_files:3},'PROJECT-FALLBACK-ID':{state:'unavailable'}};",
    "window.commitResult={status:'pushed',changed_files:3,commit_sha:'1234567890abcdef'};",
    "const C_ALPHA_AM='11111111-1111-4111-8111-111111111111',C_ALPHA_SE='11111111-1111-4111-8111-111111111112',C_BETA_AM='22222222-2222-4222-8222-222222222221',C_BETA_SE='22222222-2222-4222-8222-222222222222',C_FB_AM='33333333-3333-4333-8333-333333333331';",
    "window.conversationsByProject={'PROJECT-ALPHA':[{id:C_ALPHA_AM,conversation_id:C_ALPHA_AM,title:'Alpha Architecture Discussion',agent_id:'am-1',project_id:'PROJECT-ALPHA'},{id:C_ALPHA_SE,conversation_id:C_ALPHA_SE,title:'Alpha System Discussion',agent_id:'se-1',project_id:'PROJECT-ALPHA'}],'PROJECT-BETA':[{id:C_BETA_AM,conversation_id:C_BETA_AM,title:'Beta Architecture Discussion',agent_id:'am-1',project_id:'PROJECT-BETA'},{id:C_BETA_SE,conversation_id:C_BETA_SE,title:'Beta System Discussion',agent_id:'se-1',project_id:'PROJECT-BETA'}],'PROJECT-FALLBACK-ID':[{id:C_FB_AM,conversation_id:C_FB_AM,title:'Fallback Conversation Title',agent_id:'am-1',project_id:'PROJECT-FALLBACK-ID'}]};",
    "window.messagesByConv={[C_ALPHA_AM]:[{id:'m-a1',message_id:'m-a1',kind:'agent',from:'agent',agent_id:'am-1',conversation_id:C_ALPHA_AM,timestamp:'2026-10-30T00:00:00Z',text:'History in Alpha Architecture',content:{text:'History in Alpha Architecture',content_type:'text/plain'}}],[C_ALPHA_SE]:[{id:'m-as1',message_id:'m-as1',kind:'agent',from:'agent',agent_id:'se-1',conversation_id:C_ALPHA_SE,timestamp:'2026-10-30T00:00:00Z',text:'History in Alpha System',content:{text:'History in Alpha System',content_type:'text/plain'}}],[C_BETA_AM]:[{id:'m-b1',message_id:'m-b1',kind:'agent',from:'agent',agent_id:'am-1',conversation_id:C_BETA_AM,timestamp:'2026-10-30T00:00:00Z',text:'History in Beta Architecture',content:{text:'History in Beta Architecture',content_type:'text/plain'}}],[C_BETA_SE]:[{id:'m-bs1',message_id:'m-bs1',kind:'agent',from:'agent',agent_id:'se-1',conversation_id:C_BETA_SE,timestamp:'2026-10-30T00:00:00Z',text:'History in Beta System',content:{text:'History in Beta System',content_type:'text/plain'}}]};",
    "window.clarificationsByConv={[C_ALPHA_AM]:[{session_id:'CLAR-1',project_id:'PROJECT-ALPHA',conversation_id:C_ALPHA_AM,source_path:'docs/plan.md',source_sha256:'abc123',version:1,status:'awaiting_owner_decisions',selections:{},notes:{},questions:[{id:'q1',title:'Header layout policy',reason:'Confirm header structure',recommended_option_id:'opt-a',options:[{id:'opt-a',label:'Two-sided header',description:'Title left, project and Git right'}]}]}]};",
    "window.fetch=async(input,init={})=>{const url=new URL(input,location.origin),method=init.method||'GET',body=init.body?JSON.parse(init.body):null;",
    "const project=url.searchParams.get('project')??url.searchParams.get('project_id')??body?.project_id??'PROJECT-ALPHA';",
    "window.calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method,body});",
    "if(url.pathname.endsWith('/lifecycle/list')||url.pathname==='/forge/v1/projects')return Response.json({projects:window.projects});",
    "if(url.pathname.endsWith('/agents')){const role=url.searchParams.get('role');return Response.json({agents:role?window.agents.filter(a=>a.role===role):window.agents});}",
    "if(url.pathname.includes('/agents/')&&method==='PUT'){const id=url.pathname.split('/').pop();window.agents=window.agents.map(a=>a.agent_id===id?{...a,...body}:a);return Response.json({agent_id:id,...body});}",
    "if(url.pathname.endsWith('/git/status')){const st=window.gitByProject[project];if(!st||st.error)return Response.json({error:{message:'Git failed'}},{status:503});return Response.json(st);}",
    "if(url.pathname.endsWith('/git/commit-push')){window.gitByProject[project]={state:'clean',branch:window.gitByProject[project]?.branch??'main',changed_files:0};return Response.json(window.commitResult);}",
    "if(url.pathname.endsWith('/conversations')&&method==='GET'){const agentId=url.searchParams.get('agent_id');const list=(window.conversationsByProject[project]??[]).filter(c=>!agentId||c.agent_id===agentId);return Response.json({items:list});}",
    "if(url.pathname.endsWith('/conversations')&&method==='POST'){const created={id:'conv-created-'+project,conversation_id:'conv-created-'+project,title:body?.title||'New conversation',agent_id:body?.agent_id,project_id:project};window.conversationsByProject[project]=[created,...(window.conversationsByProject[project]??[])];return Response.json(created);}",
    "if(url.pathname.includes('/conversations/')&&url.pathname.endsWith('/messages')&&method==='GET'){const cid=decodeURIComponent(url.pathname.split('/')[4]);return Response.json({items:window.messagesByConv[cid]??[]});}",
    "if(url.pathname.includes('/conversations/')&&url.pathname.endsWith('/messages')&&method==='POST'){const cid=decodeURIComponent(url.pathname.split('/')[4]);const msg={id:body.message_id,message_id:body.message_id,kind:'owner',from:'owner',conversation_id:cid,timestamp:body.timestamp,text:body.payload?.text??'',content:{text:body.payload?.text??'',content_type:'text/plain'}};window.messagesByConv[cid]=[...(window.messagesByConv[cid]??[]),msg];return Response.json({status:'accepted',message_id:body.message_id,conversation_id:cid});}",
    "if(url.pathname.includes('/plan-clarifications')&&method==='GET'){const cid=decodeURIComponent(url.pathname.split('/')[4]);return Response.json(window.clarificationsByConv[cid]??[]);}",
    "if(url.pathname.includes('/plan-clarifications/')&&method==='PATCH'){const parts=url.pathname.split('/');const cid=decodeURIComponent(parts[4]);const sid=decodeURIComponent(parts[6]);const list=window.clarificationsByConv[cid]??[];const updated=list.map(s=>s.session_id===sid?{...s,selections:body.selections,notes:body.notes,version:s.version+1}:s);window.clarificationsByConv[cid]=updated;return Response.json(updated.find(s=>s.session_id===sid));}",
    "return Response.json({items:[],project_id:project});};",
    "window.EventSource=class{constructor(url){this.url=String(url);this.readyState=1;this.closed=false;window.sources.push(this);queueMicrotask(()=>this.onopen?.({}));}addEventListener(){}close(){this.closed=true;this.readyState=2;}};",
    "function FixtureApp(){const[pathname,setPathname]=useState(()=>window.location.pathname==='/'?'/PROJECT-ALPHA':window.location.pathname);const[rev,setRev]=useState(0);",
    "useEffect(()=>{window.navigateTo=p=>{window.history.pushState({},'',p);setPathname(p);};window.rerenderFixture=()=>setRev(r=>r+1);},[]);",
    "const segs=pathname.split('/').filter(Boolean);",
    "const nav=useMemo(()=>({pathname,params:segs[0]?{projectId:decodeURIComponent(segs[0])}:{},router:{push:p=>window.navigateTo(p),replace:p=>window.navigateTo(p)}}),[pathname]);",
    "const view=segs[1]==='system'?<ProjectSystemPage key={pathname+':'+rev}/>:<ProjectPage key={pathname+':'+rev}/>;",
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

// Business purpose: navigates the Chromium test fixture to a requested project route and waits for the chat header and Git indicator to render.
// Technical description: calls `window.navigateTo(pathname)` after loading `origin`, waits until `.claude-chat-header` and `.workspace-git-status` are mounted in the DOM, and closes default floating monitor windows if they overlap header controls on narrow viewports.
async function openChatRoute(page, origin, pathname, { keepMonitors = false } = {}) {
  if (new URL(page.url()).origin !== origin) await page.goto(origin);
  await page.evaluate((target) => window.navigateTo(target), pathname);
  await page.locator(".claude-chat-header .workspace-git-status").waitFor({ state: "attached" });
  if (!keepMonitors) {
    for (const label of ["Close Watcher monitor", "Close Agent monitor"]) {
      const btn = page.locator(`button[aria-label="${label}"]`);
      if (await btn.count() > 0 && await btn.first().isVisible()) await btn.first().click();
    }
  }
}

export const browserAssertions = {
  "Architecture and System place the active conversation title on the left and the current project name and one GitStatusIndicator on the right of the header above the conversation.": async ({ page, origin }) => {
    for (const [route, expectedTitle] of [["/PROJECT-ALPHA", "Alpha Architecture Discussion"], ["/PROJECT-ALPHA/system", "Alpha System Discussion"]]) {
      await openChatRoute(page, origin, route);
      await page.waitForFunction((title) => document.querySelector(".claude-chat-header h1")?.textContent === title, expectedTitle);
      const layout = await page.evaluate(() => {
        const header = document.querySelector(".claude-chat-header");
        const scroll = document.querySelector(".claude-chat-scroll");
        const titleEl = header?.querySelector("h1");
        const rightEl = header?.querySelector(".claude-chat-header-project");
        const projectNameEl = rightEl?.querySelector(".claude-chat-header-project-name");
        const gitEls = document.querySelectorAll(".workspace-git-status");
        const headerRect = header?.getBoundingClientRect();
        const scrollRect = scroll?.getBoundingClientRect();
        const titleRect = titleEl?.getBoundingClientRect();
        const rightRect = rightEl?.getBoundingClientRect();
        return {
          titleText: titleEl?.textContent,
          projectName: projectNameEl?.textContent,
          gitCountAll: gitEls.length,
          gitCountInHeader: header?.querySelectorAll(".workspace-git-status").length ?? 0,
          headerAboveScroll: Boolean(headerRect && scrollRect && headerRect.bottom <= scrollRect.top + 20),
          leftRightOrder: Boolean(titleRect && rightRect && titleRect.left < rightRect.left)
        };
      });
      assert.equal(layout.titleText, expectedTitle);
      assert.equal(layout.projectName, "Alpha Catalog Name");
      assert.equal(layout.gitCountInHeader, 1);
      assert.equal(layout.gitCountAll, 1);
      assert.equal(layout.headerAboveScroll, true);
      assert.equal(layout.leftRightOrder, true);
    }
  },

  "Changing project context updates the displayed catalog name or PROJECT_ID fallback and Git request identity; branch, clean and dirty states and Commit & push and Retry interactions retain their behavior.": async ({ page, origin }) => {
    await openChatRoute(page, origin, "/PROJECT-ALPHA");
    await page.waitForFunction(() => document.querySelector(".claude-chat-header .workspace-git-status strong")?.textContent === "Clean");
    assert.equal(await page.locator(".claude-chat-header-project-name").textContent(), "Alpha Catalog Name");
    assert.equal(await page.locator(".claude-chat-header .workspace-git-status small").textContent(), "main");

    await openChatRoute(page, origin, "/PROJECT-BETA");
    await page.waitForFunction(() => document.querySelector(".claude-chat-header .workspace-git-status strong")?.textContent === "3 changed");
    assert.equal(await page.locator(".claude-chat-header-project-name").textContent(), "Beta Catalog Name");
    assert.equal(await page.locator(".claude-chat-header .workspace-git-status small").first().textContent(), "feature/o2-header");
    const commitBtn = page.locator('.claude-chat-header .workspace-git-status button[title="Commit and push all changed files"]');
    assert.equal(await commitBtn.count(), 1);
    await commitBtn.click();
    await page.waitForFunction(() => document.querySelector(".workspace-git-action-result")?.textContent?.includes("Pushed 3 changed files."));
    const commitCalls = await page.evaluate(() => window.calls.filter((c) => c.path.endsWith("/git/commit-push")));
    assert.equal(commitCalls.length, 1);
    assert.equal(commitCalls[0].query.project, "PROJECT-BETA");
    assert.equal(commitCalls[0].body.project_id, "PROJECT-BETA");

    await openChatRoute(page, origin, "/PROJECT-FALLBACK-ID");
    await page.waitForFunction(() => document.querySelector(".claude-chat-header .workspace-git-status strong")?.textContent === "Git unavailable");
    assert.equal(await page.locator(".claude-chat-header-project-name").textContent(), "PROJECT-FALLBACK-ID");
    await page.evaluate(() => { window.gitByProject["PROJECT-FALLBACK-ID"] = { state: "clean", branch: "release/v1", changed_files: 0 }; });
    await page.locator(".claude-chat-header .workspace-git-status button", { hasText: "Retry" }).click();
    await page.waitForFunction(() => document.querySelector(".claude-chat-header .workspace-git-status strong")?.textContent === "Clean");
    assert.equal(await page.locator(".claude-chat-header .workspace-git-status small").textContent(), "release/v1");
  },

  "SystemToolMode shows no duplicate project and Git cluster, and the agent Settings menu still opens, changes settings and saves through the existing client.": async ({ page, origin }) => {
    for (const [route, agentId] of [["/PROJECT-ALPHA", "am-1"], ["/PROJECT-ALPHA/system", "se-1"]]) {
      await openChatRoute(page, origin, route);
      await page.locator(".composer-agent-settings-toggle").waitFor({ state: "visible" });
      assert.equal(await page.locator(".claude-composer-tool-mode .home-plan-approval-project").count(), 0);
      assert.equal(await page.locator(".claude-composer-tool-mode .workspace-git-status").count(), 0);
      assert.equal(await page.locator(".workspace-git-status").count(), 1);

      await page.locator(".composer-agent-settings-toggle").click();
      const dialog = page.locator('.composer-agent-settings-menu[role="dialog"]');
      await dialog.waitFor({ state: "visible" });
      await dialog.locator('[role="radiogroup"] [role="radio"]', { hasText: "High" }).click();
      const saveBtn = dialog.locator(".composer-agent-settings-save");
      assert.equal(await saveBtn.isDisabled(), false);
      await saveBtn.click();
      await page.waitForFunction((id) => window.calls.some((c) => c.method === "PUT" && c.path.endsWith(`/agents/${id}`)), agentId);
      const saveCall = await page.evaluate((id) => window.calls.findLast((c) => c.method === "PUT" && c.path.endsWith(`/agents/${id}`)), agentId);
      assert.equal(saveCall.body.reasoning.effort, "high");
    }
  },

  "Long titles, project names and Git states cause no horizontal page overflow and leave header controls operable.": async ({ page, viewport, origin }) => {
    await openChatRoute(page, origin, "/PROJECT-ALPHA");
    await page.evaluate(() => {
      const longTitle = "Extremely-Long-Architecture-And-System-Conversation-Title-Without-Spaces-To-Verify-Ellipsis-And-Responsive-Header-Wrapping-Behavior-Across-Viewports";
      const longProject = "Enterprise-Multi-Region-Distributed-Architecture-Workspace-Catalog-Project-Name-With-Extra-Length";
      window.projects = window.projects.map((p) => p.project_id === "PROJECT-ALPHA" ? { ...p, name: longProject } : p);
      window.api.syncProjectsToSelection(window.projects);
      window.conversationsByProject["PROJECT-ALPHA"] = window.conversationsByProject["PROJECT-ALPHA"].map((c) => ({ ...c, title: longTitle }));
      window.gitByProject["PROJECT-ALPHA"] = { state: "dirty", branch: "feature/very-long-branch-name-for-responsive-header-verification-check", changed_files: 12 };
      window.rerenderFixture();
    });
    for (const route of ["/PROJECT-ALPHA", "/PROJECT-ALPHA/system"]) {
      await openChatRoute(page, origin, route);
      await page.waitForFunction(() => document.querySelector(".claude-chat-header .workspace-git-status button")?.textContent?.includes("Commit & push"));
      const metrics = await page.evaluate((vw) => {
        const docOverflow = document.documentElement.scrollWidth <= window.innerWidth + 1;
        const header = document.querySelector(".claude-chat-header");
        const headerBox = header?.getBoundingClientRect();
        const btn = header?.querySelector(".workspace-git-status button");
        const btnBox = btn?.getBoundingClientRect();
        return {
          docOverflow,
          headerFits: Boolean(headerBox && headerBox.left >= -1 && headerBox.right <= vw + 1),
          btnOperable: Boolean(btn && !btn.disabled && btnBox && btnBox.width > 0 && btnBox.height > 0 && btnBox.right <= vw + 1)
        };
      }, viewport);
      assert.equal(metrics.docOverflow, true, `no horizontal overflow on ${route} at ${viewport}px`);
      assert.equal(metrics.headerFits, true, `header fits viewport on ${route} at ${viewport}px`);
      assert.equal(metrics.btnOperable, true, `header Git button operable on ${route} at ${viewport}px`);
    }
  },

  "Architecture and System still send messages, load history, support clarify-plan interactions and operate WorkspaceMonitorPanels after the header change.": async ({ page, origin }) => {
    await openChatRoute(page, origin, "/PROJECT-ALPHA");
    await page.getByText("History in Alpha Architecture", { exact: true }).waitFor();

    const clarCard = page.locator(".architecture-clarification-card");
    await clarCard.waitFor({ state: "visible" });
    await clarCard.locator('input[type="password"]').fill("OWNER-SECRET");
    await clarCard.locator('input[type="radio"]').first().click();
    await page.waitForFunction(() => window.calls.some((c) => c.method === "PATCH" && c.path.includes("/plan-clarifications/")));

    await page.getByRole("textbox", { name: "Chat or ticket input" }).fill("Hello from Architecture");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("Hello from Architecture", { exact: true }).waitFor();

    const watcherBtn = page.locator('.workspace-monitor-dock button', { hasText: "Watcher" });
    await watcherBtn.click();
    await page.locator('section[aria-label="Watcher monitor"]').waitFor({ state: "visible" });
    await page.locator('button[aria-label="Close Watcher monitor"]').click();
    assert.equal(await page.locator('section[aria-label="Watcher monitor"]').count(), 0);

    await openChatRoute(page, origin, "/PROJECT-ALPHA/system");
    await page.getByText("History in Alpha System", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "Chat or ticket input" }).fill("Hello from System");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("Hello from System", { exact: true }).waitFor();

    const agentMonitorBtn = page.locator('.workspace-monitor-dock button', { hasText: "Agent activity" });
    await agentMonitorBtn.click();
    await page.locator('section[aria-label="Agent activity monitor"]').waitFor({ state: "visible" });
    await page.locator('button[aria-label="Close Agent monitor"]').click();
    assert.equal(await page.locator('section[aria-label="Agent activity monitor"]').count(), 0);
  }
};

// Allow focused verification to invoke the same Node-owned browser runner before committing.
if (process.argv[1]?.endsWith("conversation-page-headers.browser.mjs")) {
  setImmediate(async () => {
    try {
      const { runBrowserVerification } = await import("../../../backend/src/modules/supervisor/browser/browser-verification-runner.js");
      const receipt = await runBrowserVerification({ projectRoot: process.cwd(), sourceRoot: process.cwd(),
        step: { kind: "browser", scenario_path: "ui/nextjs/tests/conversation-page-headers.browser.mjs", criterion_ids: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7", "AC-8"],
          viewports: [375, 768, 1440], assertions: Object.keys(browserAssertions) } });
      console.log(JSON.stringify(receipt));
    } catch (error) { console.error(error); process.exitCode = 1; }
  });
}
