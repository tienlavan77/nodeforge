// Exercises ArchitectureWorkspace and SystemPage conversation composer, inline owner message editing, SystemToolMode project/Git bar, and agent Settings in Chromium.
// Business purpose: verifies O1 acceptance criteria across mobile, tablet, and desktop viewports using real bundled Next.js components against controlled HTTP and SSE boundaries.
// Technical description: exports `createBrowserFixture` and `browserAssertions` verifying `.claude-composer-wrap` padding and composer textarea height, inline owner editor sizing and dynamic `scrollHeight` expansion/shrinkage, one header `.workspace-git-status` and one composer-toolbar `.workspace-git-status` beside project identity, operable agent Settings, and zero horizontal overflow at 375/768/1440px.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Business purpose: compiles real Next.js Architecture and System workspace pages into a self-contained browser bundle so Chromium assertions verify live composer dimensions, inline message editing, Git indicators, and Settings controls without mutating the production API.
// Technical description: bundles `ArchitectureWorkspace`, `SystemPage`, `ProjectRouteBoundary`, and project stores with controlled `fetch`, `EventSource`, and `confirm` handlers.
export async function createBrowserFixture({ sourceRoot, build }) {
  const navStub = [
    "import {createContext,useContext} from 'react';",
    "export const NavContext=createContext({pathname:'/PROJECT-ALPHA',params:{projectId:'PROJECT-ALPHA'},router:{push(){},replace(){}}});",
    "export const usePathname=()=>useContext(NavContext).pathname;export const useParams=()=>useContext(NavContext).params;",
    "export const useRouter=()=>useContext(NavContext).router;export const redirect=p=>{window.navigateTo?.(p);};"
  ].join("\n");
  const source = [
    "import React,{useEffect,useMemo,useState} from 'react';import {createRoot} from 'react-dom/client';",
    "import {NavContext} from 'next/navigation';import ProjectPage from './app/[projectId]/page.jsx';import ProjectSystemPage from './app/[projectId]/system/page.jsx';",
    "import {ProjectRouteBoundary} from './components/project-route-boundary.jsx';import * as selection from './lib/project-selection.js';import * as directory from './lib/project-directory-client.js';import './app/globals.css';",
    "window.api={...selection,...directory};window.calls=[];window.sources=[];window.fixtureErrors=[];window.confirmCalls=[];",
    "window.addEventListener('error',e=>window.fixtureErrors.push(e.error?.stack??e.message));window.addEventListener('unhandledrejection',e=>window.fixtureErrors.push(String(e.reason?.stack??e.reason)));",
    "window.confirm=msg=>{window.confirmCalls.push(msg);return true;};",
    "window.projects=[{project_id:'PROJECT-ALPHA',name:'Alpha Catalog Name',root:'/srv/alpha',readiness:'ready'},{project_id:'PROJECT-BETA',name:'Beta Catalog Name',root:'/srv/beta',readiness:'ready'},{project_id:'PROJECT-FALLBACK-ID',root:'/srv/fallback',readiness:'ready'}];",
    "window.agents=[{agent_id:'am-1',agent_name:'Architect One',role:'architecture_manager',enabled:true,provider:'codex',model:'gpt-5.3-codex',reasoning:{effort:'medium'},tool_mode:'forge'},{agent_id:'se-1',agent_name:'System Eng One',role:'system_engineer',enabled:true,provider:'codex',model:'gpt-5.3-codex',reasoning:{effort:'medium'},tool_mode:'forge'}];",
    "window.gitByProject={'PROJECT-ALPHA':{state:'clean',branch:'main',changed_files:0},'PROJECT-BETA':{state:'dirty',branch:'feature/o1-composer',changed_files:3},'PROJECT-FALLBACK-ID':{state:'unavailable'}};",
    "window.commitResult={status:'pushed',changed_files:3,commit_sha:'1234567890abcdef'};",
    "const LONG_OWNER_TEXT=Array.from({length:12},(_,i)=>`Owner requirement line ${i+1}: verify inline editor auto-expands height immediately from scrollHeight without vertical scrollbar truncation across all responsive viewports.`).join('\\n');",
    "const C_ALPHA_AM='11111111-1111-4111-8111-111111111111',C_ALPHA_SE='11111111-1111-4111-8111-111111111112',C_BETA_AM='22222222-2222-4222-8222-222222222221',C_BETA_SE='22222222-2222-4222-8222-222222222222';",
    "window.conversationsByProject={'PROJECT-ALPHA':[{id:C_ALPHA_AM,conversation_id:C_ALPHA_AM,title:'Alpha Architecture Discussion',agent_id:'am-1',project_id:'PROJECT-ALPHA'},{id:C_ALPHA_SE,conversation_id:C_ALPHA_SE,title:'Alpha System Discussion',agent_id:'se-1',project_id:'PROJECT-ALPHA'}],'PROJECT-BETA':[{id:C_BETA_AM,conversation_id:C_BETA_AM,title:'Beta Architecture Discussion',agent_id:'am-1',project_id:'PROJECT-BETA'},{id:C_BETA_SE,conversation_id:C_BETA_SE,title:'Beta System Discussion',agent_id:'se-1',project_id:'PROJECT-BETA'}]};",
    "window.messagesByConv={[C_ALPHA_AM]:[{id:'m-owner-a1',message_id:'m-owner-a1',kind:'owner',from:'owner',conversation_id:C_ALPHA_AM,timestamp:'2026-10-30T00:00:00Z',text:LONG_OWNER_TEXT,content:{text:LONG_OWNER_TEXT,content_type:'text/plain'}},{id:'m-a1',message_id:'m-a1',kind:'agent',from:'agent',agent_id:'am-1',conversation_id:C_ALPHA_AM,timestamp:'2026-10-30T00:01:00Z',text:'History in Alpha Architecture',content:{text:'History in Alpha Architecture',content_type:'text/plain'}}],[C_ALPHA_SE]:[{id:'m-owner-s1',message_id:'m-owner-s1',kind:'owner',from:'owner',conversation_id:C_ALPHA_SE,timestamp:'2026-10-30T00:00:00Z',text:LONG_OWNER_TEXT,content:{text:LONG_OWNER_TEXT,content_type:'text/plain'}},{id:'m-as1',message_id:'m-as1',kind:'agent',from:'agent',agent_id:'se-1',conversation_id:C_ALPHA_SE,timestamp:'2026-10-30T00:01:00Z',text:'History in Alpha System',content:{text:'History in Alpha System',content_type:'text/plain'}}]};",
    "window.fetch=async(input,init={})=>{const url=new URL(input,location.origin),method=init.method||'GET',body=init.body?JSON.parse(init.body):null;",
    "const project=url.searchParams.get('project')??url.searchParams.get('project_id')??body?.project_id??'PROJECT-ALPHA';",
    "window.calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method,body});",
    "if(url.pathname==='/model-catalog.json')return Response.json({providers:{anthropic:[{value:'claude-opus-4-6',label:'Claude Opus 4.6'},{value:'claude-sonnet-4-6',label:'Claude Sonnet 4.6'}],codex:[{value:'gpt-5.3-codex',label:'GPT-5.3 Codex'}],openai:[{value:'gpt-5',label:'GPT-5'}]}});",
    "if(url.pathname.endsWith('/lifecycle/list')||url.pathname==='/forge/v1/projects')return Response.json({projects:window.projects});",
    "if(url.pathname.endsWith('/agents')){const role=url.searchParams.get('role');return Response.json({agents:role?window.agents.filter(a=>a.role===role):window.agents});}",
    "if(url.pathname.includes('/agents/')&&method==='PUT'){const id=url.pathname.split('/').pop();window.agents=window.agents.map(a=>a.agent_id===id?{...a,...body}:a);return Response.json({agent_id:id,...body});}",
    "if(url.pathname.endsWith('/git/status')){const st=window.gitByProject[project];if(!st||st.error)return Response.json({error:{message:'Git failed'}},{status:503});return Response.json(st);}",
    "if(url.pathname.endsWith('/git/commit-push')){window.gitByProject[project]={state:'clean',branch:window.gitByProject[project]?.branch??'main',changed_files:0};return Response.json(window.commitResult);}",
    "if(url.pathname.endsWith('/conversations')&&method==='GET'){const agentId=url.searchParams.get('agent_id');const list=(window.conversationsByProject[project]??[]).filter(c=>!agentId||c.agent_id===agentId);return Response.json({items:list});}",
    "if(url.pathname.includes('/conversations/')&&url.pathname.endsWith('/messages')&&method==='GET'){const cid=decodeURIComponent(url.pathname.split('/')[4]);return Response.json({items:window.messagesByConv[cid]??[]});}",
    "if(url.pathname.includes('/conversations/')&&url.pathname.endsWith('/messages')&&method==='POST'){const cid=decodeURIComponent(url.pathname.split('/')[4]);const msg={id:body.message_id,message_id:body.message_id,supersedes_message_id:body.supersedes_message_id??body.payload?.supersedes_message_id??null,kind:'owner',from:'owner',conversation_id:cid,timestamp:body.timestamp,text:body.payload?.text??'',content:{text:body.payload?.text??'',content_type:'text/plain'}};window.messagesByConv[cid]=[...(window.messagesByConv[cid]??[]),msg];return Response.json({status:'accepted',message_id:body.message_id,conversation_id:cid});}",
    "if(url.pathname.includes('/plan-clarifications'))return Response.json([]);",
    "return Response.json({items:[],project_id:project});};",
    "window.EventSource=class{constructor(url){this.url=String(url);this.readyState=1;this.closed=false;window.sources.push(this);queueMicrotask(()=>this.onopen?.({}));}addEventListener(){}close(){this.closed=true;this.readyState=2;}};",
    "function FixtureApp(){const[pathname,setPathname]=useState(()=>window.location.pathname==='/'?'/PROJECT-ALPHA':window.location.pathname);const[rev,setRev]=useState(0);",
    "useEffect(()=>{window.navigateTo=p=>{window.history.pushState({},'',p);setPathname(p);};window.rerenderFixture=()=>setRev(r=>r+1);},[]);",
    "const segs=pathname.split('/').filter(Boolean);const nav=useMemo(()=>({pathname,params:segs[0]?{projectId:decodeURIComponent(segs[0])}:{},router:{push:p=>window.navigateTo(p),replace:p=>window.navigateTo(p)}}),[pathname]);",
    "const view=segs[1]==='system'?<ProjectSystemPage key={pathname+':'+rev}/>:<ProjectPage key={pathname+':'+rev}/>;",
    "return <NavContext.Provider value={nav}><ProjectRouteBoundary>{view}</ProjectRouteBoundary></NavContext.Provider>;};createRoot(document.getElementById('root')).render(<FixtureApp/>);"
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

// Business purpose: navigates the Chromium test fixture to a requested project route and waits for the chat header and composer Git indicators to render.
// Technical description: calls `window.navigateTo(pathname)` after loading `origin`, waits until `.claude-chat-header .workspace-git-status` and `.claude-composer-tool-mode .workspace-git-status` are mounted, and closes floating monitor windows so narrow viewports remain unobstructed.
async function openChatRoute(page, origin, pathname) {
  if (new URL(page.url()).origin !== origin) await page.goto(origin);
  await page.waitForFunction(() => typeof window.navigateTo === "function");
  await page.evaluate((target) => window.navigateTo(target), pathname);
  await page.locator(".claude-chat-header .workspace-git-status").waitFor({ state: "attached" });
  await page.locator(".claude-composer-tool-mode .workspace-git-status").waitFor({ state: "attached" });
  await page.evaluate(() => {
    for (const label of ["Close Watcher monitor", "Close Agent monitor"]) {
      document.querySelector(`button[aria-label="${label}"]`)?.click();
    }
  });
}

export const browserAssertions = {
  "On AM and System, computed composer padding is 12px 0px 30px and the composer textarea minimum height is 110px.": async ({ page, origin }) => {
    for (const route of ["/PROJECT-ALPHA", "/PROJECT-ALPHA/system"]) {
      await openChatRoute(page, origin, route);
      const styles = await page.evaluate(() => {
        const wrap = document.querySelector(".claude-composer-wrap"), textarea = document.querySelector(".claude-composer-wrap .home-composer textarea");
        const wrapStyle = wrap ? getComputedStyle(wrap) : null, taStyle = textarea ? getComputedStyle(textarea) : null;
        return { padding: wrapStyle ? `${wrapStyle.paddingTop} ${wrapStyle.paddingRight} ${wrapStyle.paddingBottom} ${wrapStyle.paddingLeft}` : "", minHeight: taStyle?.minHeight ?? "", height: textarea?.getBoundingClientRect().height ?? 0 };
      });
      assert.equal(styles.padding, "12px 0px 30px 0px");
      assert.equal(styles.minHeight, "110px");
      assert.ok(styles.height >= 110, `expected composer textarea height >= 110, got ${styles.height}`);
    }
  },

  "Opening Edit message on a long multiline owner message immediately displays its complete text without vertical textarea scrolling; adding and removing draft text recalculates height against scrollHeight.": async ({ page, origin }) => {
    for (const route of ["/PROJECT-ALPHA", "/PROJECT-ALPHA/system"]) {
      await openChatRoute(page, origin, route);
      await page.locator('.claude-message.is-owner button[aria-label="Edit message"]').first().click();
      const textarea = page.locator(".claude-message-inline-edit textarea");
      await textarea.waitFor({ state: "visible" });
      const initial = await textarea.evaluate((el) => ({ value: el.value, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, styleHeight: el.style.height }));
      assert.ok(initial.value.includes("Owner requirement line 12"), "full multiline owner message loaded");
      assert.equal(initial.styleHeight, `${initial.scrollHeight}px`);
      assert.ok(initial.clientHeight >= initial.scrollHeight - 2, `initial clientHeight ${initial.clientHeight} should fit scrollHeight ${initial.scrollHeight}`);
      await textarea.fill(`${initial.value}\n${Array.from({ length: 8 }, (_, idx) => `Added draft line ${idx + 1} for dynamic expansion verification.`).join("\n")}`);
      const expanded = await textarea.evaluate((el) => ({ clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, styleHeight: el.style.height }));
      assert.ok(expanded.scrollHeight > initial.scrollHeight, "adding lines increases scrollHeight");
      assert.equal(expanded.styleHeight, `${expanded.scrollHeight}px`);
      assert.ok(expanded.clientHeight >= expanded.scrollHeight - 2, "expanded textarea fits full draft without vertical scroll");
      await textarea.fill("Short single-line correction.");
      const shrunk = await textarea.evaluate((el) => ({ clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, styleHeight: el.style.height }));
      assert.ok(shrunk.scrollHeight < expanded.scrollHeight, "removing lines decreases scrollHeight");
      assert.equal(shrunk.styleHeight, `${shrunk.scrollHeight}px`);
      assert.ok(shrunk.clientHeight >= shrunk.scrollHeight - 2);
      await page.locator('.claude-message-inline-edit button[aria-label="Cancel edit"]').click();
    }
  },

  "The inline editor has width min(100%, 700px) and border-box sizing; its textarea has width 100%, border-box sizing, and hidden vertical overflow.": async ({ page, origin }) => {
    const css = await readFile("ui/nextjs/app/styles/message-actions.css", "utf8");
    assert.match(css, /\.claude-message-inline-edit \{[\s\S]*?width: min\(100%, 700px\);[\s\S]*?box-sizing: border-box;/);
    assert.match(css, /\.claude-message-inline-edit textarea \{[\s\S]*?width: 100%;[\s\S]*?box-sizing: border-box;[\s\S]*?overflow-y: hidden;/);
    for (const route of ["/PROJECT-ALPHA", "/PROJECT-ALPHA/system"]) {
      await openChatRoute(page, origin, route);
      await page.locator('.claude-message.is-owner button[aria-label="Edit message"]').first().click();
      const box = await page.evaluate(() => {
        const wrap = document.querySelector(".claude-message-inline-edit"), ta = wrap?.querySelector("textarea");
        const wrapStyle = wrap ? getComputedStyle(wrap) : null, taStyle = ta ? getComputedStyle(ta) : null;
        const wrapRect = wrap?.getBoundingClientRect(), parentRect = wrap?.parentElement?.getBoundingClientRect();
        return { wrapBoxSizing: wrapStyle?.boxSizing, taBoxSizing: taStyle?.boxSizing, taOverflowY: taStyle?.overflowY, wrapWidth: wrapRect?.width ?? 0, expectedMax: Math.min(parentRect?.width ?? 700, 700), taWidth: ta?.getBoundingClientRect().width ?? 0 };
      });
      assert.deepEqual([box.wrapBoxSizing, box.taBoxSizing, box.taOverflowY], ["border-box", "border-box", "hidden"]);
      assert.ok(Math.abs(box.wrapWidth - box.expectedMax) <= 1.5, `wrapWidth ${box.wrapWidth} should match min(100%, 700px)=${box.expectedMax}`);
      assert.ok(Math.abs(box.taWidth - box.wrapWidth) <= 1.5, `textarea width ${box.taWidth} should match wrapper width ${box.wrapWidth}`);
      await page.locator('.claude-message-inline-edit button[aria-label="Cancel edit"]').click();
    }
  },

  "On AM and System, exactly one Git status appears in the header and exactly one appears beside the current project name on the left of the composer toolbar; Settings remains on the right.": async ({ page, origin }) => {
    for (const route of ["/PROJECT-ALPHA", "/PROJECT-ALPHA/system"]) {
      await openChatRoute(page, origin, route);
      const layout = await page.evaluate(() => {
        const header = document.querySelector(".claude-chat-header"), toolbar = document.querySelector(".claude-composer-tool-mode");
        const leftProject = toolbar?.querySelector(".home-plan-approval-project"), settings = toolbar?.querySelector(".composer-agent-settings");
        const leftRect = leftProject?.getBoundingClientRect(), settingsRect = settings?.getBoundingClientRect();
        return {
          totalGit: document.querySelectorAll(".workspace-git-status").length, headerGit: header?.querySelectorAll(".workspace-git-status").length ?? 0,
          toolbarGit: toolbar?.querySelectorAll(".workspace-git-status").length ?? 0, leftProjectGit: leftProject?.querySelectorAll(".workspace-git-status").length ?? 0,
          projectName: leftProject?.querySelector(".claude-chat-header-project-name")?.textContent, leftBeforeRight: Boolean(leftRect && settingsRect && leftRect.left <= settingsRect.left)
        };
      });
      assert.deepEqual([layout.headerGit, layout.toolbarGit, layout.leftProjectGit, layout.totalGit, layout.projectName, layout.leftBeforeRight], [1, 1, 1, 2, "Alpha Catalog Name", true]);
    }
  },

  "Provider, Model, Effort, and Tools settings remain operable and save the intended agent configuration.": async ({ page, origin }) => {
    for (const [route, agentId, expectedToolsDisabled] of [["/PROJECT-ALPHA", "am-1", true], ["/PROJECT-ALPHA/system", "se-1", false]]) {
      await openChatRoute(page, origin, route);
      await page.locator(".composer-agent-settings-toggle").click();
      const dialog = page.locator('.composer-agent-settings-menu[role="dialog"]');
      await dialog.waitFor({ state: "visible" });
      await dialog.locator("label", { hasText: "Provider" }).locator("select").selectOption("anthropic");
      const selectedModel = await dialog.locator("label", { hasText: "Model" }).locator("select").inputValue();
      assert.ok(selectedModel.length > 0, "provider switch keeps a valid model selected");
      await dialog.locator('[role="radiogroup"] [role="radio"]', { hasText: "High" }).click();
      const builtinRadio = dialog.locator('[role="radiogroup"] [role="radio"]', { hasText: "Built-in" });
      assert.equal(await builtinRadio.isDisabled(), expectedToolsDisabled);
      if (!expectedToolsDisabled) await builtinRadio.click();
      await dialog.locator(".composer-agent-settings-save").click();
      await page.waitForFunction((id) => window.calls.some((c) => c.method === "PUT" && c.path.endsWith(`/agents/${id}`)), agentId);
      const saveCall = await page.evaluate((id) => window.calls.findLast((c) => c.method === "PUT" && c.path.endsWith(`/agents/${id}`)), agentId);
      assert.deepEqual([saveCall.body.provider, saveCall.body.model, saveCall.body.reasoning.effort, saveCall.body.tool_mode], ["anthropic", selectedModel, "high", expectedToolsDisabled ? "forge" : "builtin"]);
    }
  },

  "Long project names, long messages, inline editing, and an open Settings menu produce no horizontal document overflow.": async ({ page, viewport, origin }) => {
    await openChatRoute(page, origin, "/PROJECT-ALPHA");
    await page.evaluate(() => {
      const longProject = "Enterprise-Multi-Region-Distributed-Architecture-Workspace-Catalog-Project-Name-With-Extra-Length";
      window.projects = window.projects.map((p) => p.project_id === "PROJECT-ALPHA" ? { ...p, name: longProject } : p);
      window.api.syncProjectsToSelection(window.projects);
      window.gitByProject["PROJECT-ALPHA"] = { state: "dirty", branch: "feature/very-long-branch-name-for-responsive-composer-toolbar-check", changed_files: 12 };
      window.rerenderFixture();
    });
    for (const route of ["/PROJECT-ALPHA", "/PROJECT-ALPHA/system"]) {
      await openChatRoute(page, origin, route);
      await page.locator('.claude-message.is-owner button[aria-label="Edit message"]').first().click();
      await page.locator(".claude-message-inline-edit textarea").waitFor({ state: "visible" });
      await page.locator(".composer-agent-settings-toggle").click();
      await page.locator('.composer-agent-settings-menu[role="dialog"]').waitFor({ state: "visible" });
      const overflow = await page.evaluate((vw) => {
        const menuRect = document.querySelector(".composer-agent-settings-menu")?.getBoundingClientRect(), editRect = document.querySelector(".claude-message-inline-edit")?.getBoundingClientRect();
        return { docFits: document.documentElement.scrollWidth <= window.innerWidth + 1, menuFits: Boolean(menuRect && menuRect.left >= -1 && menuRect.right <= vw + 1), editorFits: Boolean(editRect && editRect.left >= -1 && editRect.right <= vw + 1) };
      }, viewport);
      assert.deepEqual([overflow.docFits, overflow.menuFits, overflow.editorFits], [true, true, true]);
    }
  },

  "The committed focused tests assert the approved composer dimensions and editor sizing behavior.": async () => {
    const [segTest, revTest] = await Promise.all([readFile("ui/nextjs/tests/settings-segmented-controls.test.js", "utf8"), readFile("ui/nextjs/tests/conversation-message-revisions.test.js", "utf8")]);
    assert.match(segTest, /padding: 12px 0 30px/);
    assert.match(segTest, /min-height: 110px/);
    assert.match(revTest, /width: min\\\(100%, 700px\\\)/);
    assert.match(revTest, /overflow-y: hidden/);
    assert.match(revTest, /resizeInlineEditTextarea/);
  },

  "The committed focused tests assert the SystemToolMode project and Git status rendering.": async () => {
    const segTest = await readFile("ui/nextjs/tests/settings-segmented-controls.test.js", "utf8");
    assert.match(segTest, /GitStatusIndicator/);
    assert.match(segTest, /resolveConversationProjectName/);
    assert.match(segTest, /home-plan-approval-project/);
  },

  "The committed focused tests assert one header Git status and one composer-toolbar Git status.": async ({ page, origin }) => {
    const segTest = await readFile("ui/nextjs/tests/settings-segmented-controls.test.js", "utf8");
    assert.match(segTest, /ConversationHeaderProjectGit/);
    assert.match(segTest, /SystemToolMode/);
    await openChatRoute(page, origin, "/PROJECT-ALPHA");
    assert.equal(await page.locator(".claude-chat-header .workspace-git-status").count(), 1);
    assert.equal(await page.locator(".claude-composer-tool-mode .workspace-git-status").count(), 1);
  },

  "The committed focused tests preserve revision identity and agent settings behavior.": async ({ page, origin }) => {
    const revTest = await readFile("ui/nextjs/tests/conversation-message-revisions.test.js", "utf8");
    assert.match(revTest, /supersedesMessageId/);
    assert.match(revTest, /mergeConversationRevisions/);
    await openChatRoute(page, origin, "/PROJECT-ALPHA");
    await page.locator('.claude-message.is-owner button[aria-label="Edit message"]').first().click();
    await page.locator(".claude-message-inline-edit textarea").fill("Updated owner revision text");
    await page.locator('.claude-message-inline-edit button[aria-label="Save edited message"]').click();
    await page.waitForFunction(() => window.calls.some((c) => c.method === "POST" && c.path.endsWith("/messages") && (c.body?.supersedes_message_id === "m-owner-a1" || c.body?.payload?.supersedes_message_id === "m-owner-a1")));
    await page.getByText("Updated owner revision text", { exact: true }).waitFor();
  }
};

// Allow focused verification to invoke the same Node-owned browser runner before committing.
if (process.argv[1]?.endsWith("conversation-page-headers.browser.mjs")) {
  setImmediate(async () => {
    try {
      const { runBrowserVerification } = await import("../../../backend/src/modules/supervisor/browser/browser-verification-runner.js");
      const receipt = await runBrowserVerification({ projectRoot: process.cwd(), sourceRoot: process.cwd(),
        step: { kind: "browser", scenario_path: "ui/nextjs/tests/conversation-page-headers.browser.mjs", criterion_ids: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7", "AC-8", "AC-9", "AC-10"],
          viewports: [375, 768, 1440], assertions: Object.keys(browserAssertions) } });
      console.log(JSON.stringify(receipt));
    } catch (error) { console.error(error); process.exitCode = 1; }
  });
}
