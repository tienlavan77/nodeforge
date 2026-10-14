// Verify Coding's pinned headers and bounded agent grid with real Chromium scrolling and controls.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { launchProjectChromium } from "../../../backend/tests/helpers/chromium-cdp.js";

// Measure actual rendered tracks, overflow and control visibility without mocking layout.
const measure = `(() => {
  const monitor = document.querySelector('.coding-workspace-monitor');
  const list = document.querySelector('.coding-workspace-list');
  const column = document.querySelector('.coding-workspace-agent');
  const git = document.querySelector('.workspace-git-status');
  const header = column.querySelector('.coding-workspace-column-header');
  const rect = column.getBoundingClientRect();
  const gitRect = git.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  const panels = [...list.children];
  return {
    tracks: getComputedStyle(list).gridTemplateColumns.split(' ').length,
    monitorTracks: getComputedStyle(monitor).gridTemplateColumns.split(' ').length,
    firstRow: panels.filter(panel => Math.abs(panel.offsetTop - panels[0].offsetTop) < 2).length,
    overflow: column.scrollWidth > column.clientWidth || document.documentElement.scrollWidth > innerWidth,
    vertical: column.scrollHeight > column.clientHeight,
    headerTop: headerRect.top, columnTop: rect.top,
    gitVisible: gitRect.top >= rect.top && gitRect.bottom <= rect.bottom && gitRect.right <= rect.right,
    gitRight: Math.abs(gitRect.right - headerRect.right) < 2,
    panelCount: panels.length,
    scrollTop: column.scrollTop,
    mainScroll: monitor.scrollTop,
    pageScroll: scrollY
  };
})()`;

test("Coding headers stay column-local and the agent list fits one, two and three tracks", { timeout: 60000 }, async (context) => {
  await mkdir(join(process.cwd(), ".forge/runtime"), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), ".forge/runtime/coding-layout-"));
  context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const compiled = await build({ stdin: { contents: `
    import {createRoot} from 'react-dom/client';
    import {CodingWorkspaceMonitor} from './components/coding-workspace-monitor.jsx';
    import {PROJECT_ID} from './lib/home-page-constants.js';
    window.gitProjects=[]; window.closedPanels=[];
    const client={getGitStatus:async(projectId)=>{window.gitProjects.push(projectId);return null},listPlans:async()=>[],listPlanRequests:async()=>[]};
    const panels=Array.from({length:7},(_,index)=>({key:'panel-'+index,agentId:'coder-'+index,projectId:PROJECT_ID}));
    const agents=panels.map(panel=>({agent_id:panel.agentId,project_id:PROJECT_ID,role:'coder',name:panel.agentId,status:'idle'}));
    const activities=panels.flatMap(panel=>Array.from({length:30},(_,index)=>({event_type:'agent.activity',project_id:PROJECT_ID,payload:{agent_id:panel.agentId,summary:'Activity '+index+' '+ 'Long workspace activity content '.repeat(8),tool_name:'read_file'}})));
    createRoot(document.getElementById('root')).render(<div className="claude-home-shell coding-workspace-shell"><aside className="conversation-sidebar is-collapsed"/><CodingWorkspaceMonitor projectId={PROJECT_ID} client={client} agentPanelRegistry={{panels,activity:{},sourceStatus:'connected'}} agentDirectory={agents} agentActivities={activities} onAgentPanelClose={(projectId,agentId)=>window.closedPanels.push({projectId,agentId})}/></div>);
  `, resolveDir: join(process.cwd(), "ui/nextjs"), loader: "jsx" }, bundle: true, jsx: "automatic", write: false, format: "iife", platform: "browser" });
  const styles = await readFile(new URL("../app/styles/workspace-monitors.css", import.meta.url), "utf8");
  const gitStyles = await readFile(new URL("../app/styles/responsive-workspace.css", import.meta.url), "utf8");
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root { --app-panel:#fff; --app-border:#ccc; --app-text:#222; --app-surface-alt:#eee; }
    body {margin:0} .claude-home-shell {display:grid;height:100vh} .conversation-sidebar {min-width:0}
    ${gitStyles}\n${styles}
    </style><div id="root"></div><script src="/bundle.js"></script>`;
  const server = createServer((request, response) => {
    response.setHeader("content-type", request.url === "/bundle.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/bundle.js" ? compiled.outputFiles[0].text : html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await launchProjectChromium(join(directory, "profile"));
  context.after(() => browser.close());
  const page = await browser.page(`http://127.0.0.1:${server.address().port}/`);
  await page.wait("document.querySelectorAll('.coding-agent-monitor').length === 7 && window.gitProjects.length === 1");
  await page.evaluate(`(() => {
    const column = document.querySelector('.coding-sprint-plan');
    for(let index=0;index<60;index++) {
      const paragraph = document.createElement('p'); paragraph.textContent = 'Long Sprint Plan content '+index;
      column.append(paragraph);
    }
    const button = document.createElement('button'); button.textContent = 'Last Sprint control';
    button.onclick = () => {window.sprintClicked=true}; column.append(button);
  })()`);
  for (const [width, expectedTracks] of [[375, 1], [760, 1], [768, 1], [1440, 3]]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate("document.querySelectorAll('.coding-workspace-column').forEach(column=>column.scrollTop=0)");
    await page.wait(`getComputedStyle(document.querySelector('.coding-workspace-list')).gridTemplateColumns.split(' ').length === ${expectedTracks}`);
    const initial = await page.evaluate(measure);
    assert.equal(initial.monitorTracks, width <= 760 ? 1 : 2, `top-level split at ${width}`);
    assert.equal(initial.firstRow, expectedTracks);
    assert.equal(initial.panelCount, 7);
    assert.equal(initial.overflow, false);
    assert.equal(initial.vertical, true);
    assert.equal(initial.gitVisible, true);
    assert.equal(initial.gitRight, true);
    for (const selector of ['.coding-sprint-plan', '.coding-workspace-agent']) {
      const other = selector === '.coding-sprint-plan' ? '.coding-workspace-agent' : '.coding-sprint-plan';
      await page.evaluate(`document.querySelector('${selector}').scrollTop=500`);
      await page.wait(`document.querySelector('${selector}').scrollTop > 0`);
      const result = await page.evaluate(`(() => {
        const column=document.querySelector('${selector}'); const header=column.querySelector('.coding-workspace-column-header');
        return {top:header.getBoundingClientRect().top,columnTop:column.getBoundingClientRect().top,other:document.querySelector('${other}').scrollTop};
      })()`);
      assert.ok(Math.abs(result.top - result.columnTop) < 2, `local sticky header at ${width}`);
      assert.equal(result.other, 0, "scrolling one column does not move its neighbor");
      await page.evaluate(`document.querySelector('${selector}').scrollTop=0`);
    }
    await page.evaluate("document.querySelector('.coding-workspace-agent').scrollTop=1e7");
    const bottom = await page.evaluate(measure);
    assert.ok(bottom.scrollTop > 500);
    assert.equal(bottom.mainScroll, 0);
    assert.equal(bottom.pageScroll, 0);
    assert.equal(bottom.gitVisible, true);
    assert.ok(Math.abs(bottom.headerTop - bottom.columnTop) < 2);
    assert.equal(await page.evaluate(`(() => {
      const column=document.querySelector('.coding-workspace-agent'); const last=column.querySelector('.coding-agent-monitor:last-child > div:last-child');
      const rect=last.getBoundingClientRect();return rect.bottom <= column.getBoundingClientRect().bottom && rect.top >= column.querySelector('.coding-workspace-column-header').getBoundingClientRect().bottom;
    })()`), true, "last activity can be read below the header");
    await page.click("document.querySelector('.coding-agent-monitor:last-child button')");
    assert.equal(await page.evaluate("window.closedPanels.at(-1).agentId"), "coder-6");
    assert.equal(await page.evaluate(`(() => {
      const button=document.querySelector('.coding-agent-monitor:last-child button');const rect=button.getBoundingClientRect();
      return document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===button;
    })()`), true, "close control is not hidden by the sticky header");
    await page.click("document.querySelector('.coding-sprint-plan > button:last-child')");
    assert.equal(await page.evaluate("window.sprintClicked"), true);
  }
  await page.evaluate("document.querySelector('.conversation-sidebar').classList.remove('is-collapsed')");
  await page.wait("getComputedStyle(document.querySelector('.coding-workspace-list')).gridTemplateColumns.split(' ').length === 2");
  const expanded = await page.evaluate(measure);
  assert.equal(expanded.firstRow, 2);
  assert.equal(expanded.overflow, false);
  assert.equal(expanded.monitorTracks, 2);
  assert.deepEqual(await page.evaluate("window.gitProjects"), ["PROJECT-NODEFORGE"]);
});
