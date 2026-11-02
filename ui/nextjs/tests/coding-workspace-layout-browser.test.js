// Verify Coding's pinned headers, 2-row Workspace Agent layout, unified monitors, realtime events, project switching, and internal scrolling in Chromium.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { launchProjectChromium } from "../../../backend/tests/helpers/chromium-cdp.js";

// Measure actual rendered rows, columns, overflow, and monitor scrolling without mocking layout.
const measure = `(() => {
  const monitor = document.querySelector('.coding-workspace-monitor');
  const pageHeader = monitor.querySelector('.coding-workspace-header');
  const sprintCol = document.querySelector('.coding-sprint-plan');
  const list = document.querySelector('.coding-workspace-list');
  const column = document.querySelector('.coding-workspace-agent');
  const git = pageHeader.querySelector('.workspace-git-status');
  const header = column.querySelector('.coding-workspace-column-header');
  const rect = column.getBoundingClientRect();
  const sprintRect = sprintCol.getBoundingClientRect();
  const pageHeaderRect = pageHeader.getBoundingClientRect();
  const gitRect = git.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  const rows = [...list.querySelectorAll('.coding-workspace-row')];
  const monitors = [...list.querySelectorAll('.coding-workspace-monitor-column')];
  const contents = monitors.map(m => m.querySelector('.workspace-monitor-content'));
  const row0Rect = rows[0].getBoundingClientRect();
  const row1Rect = rows[1].getBoundingClientRect();
  const mon0Rect = monitors[0].getBoundingClientRect();
  const mon1Rect = monitors[1].getBoundingClientRect();
  return {
    monitorTracks: getComputedStyle(monitor).gridTemplateColumns.split(' ').length,
    rowCount: rows.length,
    upperRowChildren: rows[0].children.length,
    monitorCount: monitors.length,
    equalRows: Math.abs(row0Rect.height - row1Rect.height) <= 20 && row0Rect.height > 40 && row1Rect.height > 40,
    equalMonitorCols: Math.abs(mon0Rect.width - mon1Rect.width) <= 4 && mon0Rect.width > 40,
    overflow: column.scrollWidth > column.clientWidth || document.documentElement.scrollWidth > innerWidth,
    sprintScrollable: sprintCol.scrollHeight > sprintCol.clientHeight,
    activityScrollable: contents[0].scrollHeight > contents[0].clientHeight,
    watcherScrollable: contents[1].scrollHeight > contents[1].clientHeight,
    headerTop: headerRect.top, columnTop: rect.top,
    pageHeaderAboveBoth: pageHeaderRect.bottom <= sprintRect.top + 4 && pageHeaderRect.bottom <= rect.top + 4,
    gitCountInColumnHeader: header.querySelectorAll('.workspace-git-status').length,
    gitVisible: gitRect.top >= pageHeaderRect.top && gitRect.bottom <= pageHeaderRect.bottom && gitRect.right <= pageHeaderRect.right,
    gitRight: gitRect.left > pageHeader.querySelector('h1').getBoundingClientRect().right,
    mainScroll: monitor.scrollTop,
    pageScroll: scrollY
  };
})()`;

test("Coding headers stay column-local beneath the shared page header and Workspace Agent renders 2 equal rows with unified scrolling monitors and project isolation", { timeout: 60000 }, async (context) => {
  await mkdir(join(process.cwd(), ".forge/runtime"), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), ".forge/runtime/coding-layout-"));
  context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const compiled = await build({
    stdin: { contents: `
      import { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import CodingPage from './app/coding/page.jsx';
      import { PROJECT_ID } from './lib/home-page-constants.js';
      window.gitProjects = [];
      window.streamCalls = [];
      function Harness() {
        const [projectId, setProjectId] = useState(PROJECT_ID);
        window.setCodingProject = setProjectId;
        return <CodingPage projectId={projectId} />;
      }
      createRoot(document.getElementById('root')).render(<Harness />);
    `, resolveDir: join(process.cwd(), "ui/nextjs"), loader: "jsx" },
    bundle: true, jsx: "automatic", write: false, format: "iife", platform: "browser",
    plugins: [{
      name: "coding-page-browser-mocks",
      // Business purpose: Provides a controlled local control-API and navigation boundary so the browser test mounts the real CodingPage and useProjectEventStream without external network dependencies.
      // Technical description: Intercepts next/navigation, conversation-sidebar, and node-client imports during esbuild bundling while keeping CodingPage, useProjectEventStream, applyWatcherEvent, and CodingWorkspaceMonitor intact.
      setup(builder) {
        builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next-nav", namespace: "mock" }));
        builder.onLoad({ filter: /^next-nav$/, namespace: "mock" }, () => ({ contents: "export const useParams = () => ({}); export const usePathname = () => '/coding';", loader: "js" }));
        builder.onResolve({ filter: /conversation-sidebar\.jsx$/ }, () => ({ path: "sidebar", namespace: "mock" }));
        builder.onLoad({ filter: /^sidebar$/, namespace: "mock" }, () => ({ contents: "export function ConversationSidebar() { return <aside className='conversation-sidebar is-collapsed' />; }", loader: "jsx", resolveDir: join(process.cwd(), "ui/nextjs") }));
        builder.onResolve({ filter: /\/node-client\.js$/ }, () => ({ path: "node-client", namespace: "mock" }));
        builder.onLoad({ filter: /^node-client$/, namespace: "mock" }, () => ({
          contents: `
            export function createNodeClient(projectId) {
              const agents = [
                { agent_id: 'coder-1', project_id: projectId, role: 'coder', agent_name: 'Coder One', status: 'idle' },
                { agent_id: 'reviewer-1', project_id: projectId, role: 'reviewer', agent_name: 'Reviewer One', status: 'idle' },
                { agent_id: 'leader-1', project_id: projectId, role: 'sprint_leader', agent_name: 'Sprint Leader', status: 'idle' }
              ];
              return {
                getAgents: async () => agents,
                getGitStatus: async (pid) => { window.gitProjects.push(pid ?? projectId); return null; },
                getProjectDashboard: async () => ({ project_id: projectId, roadmap: { sprints: [] } }),
                listPlans: async () => [],
                listPlanRequests: async () => [],
                listCodeCheckpoints: async () => ({ checkpoints: [] }),
                connectProjectStream: (opts) => {
                  window.activeStream = opts;
                  window.streamCalls.push(opts.projectId);
                  setTimeout(() => {
                    if (window.activeStream !== opts) return;
                    opts.onOpen?.();
                    window.streamOpened = opts.projectId;
                    if (opts.projectId === 'PROJECT-NODEFORGE') {
                      for (let index = 0; index < 30; index += 1) {
                        opts.onEvent?.({
                          event_id: 'act-' + index,
                          event_type: 'agent.activity',
                          project_id: opts.projectId,
                          timestamp: '2026-11-02T10:00:00.000Z',
                          agent_color: index === 0 ? '#ffcb6b' : index % 2 === 0 ? '#89ddff' : '#000000',
                          payload: {
                            agent_id: index % 2 === 0 ? 'coder-1' : 'reviewer-1',
                            activity_type: 'tool_started',
                            status: 'working',
                            agent_color: index === 0 ? '#ffcb6b' : index === 2 ? '#89ddff' : 'transparent',
                            summary: 'Activity ' + index + ' ' + 'Long workspace activity content '.repeat(4),
                            tool_name: 'read_file'
                          }
                        });
                      }
                      opts.onEvent?.({
                        event_id: 'wat-snap',
                        event_type: 'stream.snapshot',
                        project_id: opts.projectId,
                        timestamp: '2026-11-02T10:01:00.000Z',
                        payload: {
                          watcher: {
                            recent_events: [0, 1, 2].map((idx) => ({
                              event_id: 'wat-' + idx,
                              event_type: idx % 2 === 0 ? 'watcher.file_indexed' : 'watcher.file_removed',
                              project_id: opts.projectId,
                              timestamp: '2026-11-02T10:01:0' + idx + '.000Z',
                              payload: { activity: Array.from({ length: 8 }, (_, sub) => 'src/module-' + idx + '-' + sub + '.js') }
                            }))
                          }
                        }
                      });
                      opts.onEvent?.({
                        event_id: 'wat-live',
                        event_type: 'watcher.file_indexed',
                        project_id: opts.projectId,
                        timestamp: '2026-11-02T10:01:09.000Z',
                        payload: { activity: Array.from({ length: 8 }, (_, sub) => 'src/live-' + sub + '.js') }
                      });
                    }
                  }, 10);
                  return { close() { window.closedStreamProject = opts.projectId; } };
                }
              };
            }
          `,
          loader: "js"
        }));
      }
    }]
  });
  const styles = await readFile(new URL("../app/styles/workspace-monitors.css", import.meta.url), "utf8");
  const homeStyles = await readFile(new URL("../app/styles/home-workspace.css", import.meta.url), "utf8");
  const convStyles = await readFile(new URL("../app/styles/home-conversation.css", import.meta.url), "utf8");
  const gitStyles = await readFile(new URL("../app/styles/responsive-workspace.css", import.meta.url), "utf8");
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root { --app-panel:#fff; --app-border:#ccc; --app-text:#222; --app-surface-alt:#eee; }
    body {margin:0} .claude-home-shell {display:grid;height:100vh} .conversation-sidebar {min-width:0}
    ${homeStyles}\n${convStyles}\n${gitStyles}\n${styles}
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
  await page.wait("document.querySelectorAll('.coding-workspace-monitor-column').length === 2 && document.querySelectorAll('.workspace-monitor-content article').length >= 60 && window.gitProjects.length >= 1");
  await page.evaluate(`(() => {
    const column = document.querySelector('.coding-sprint-plan');
    for(let index=0;index<60;index++) {
      const paragraph = document.createElement('p'); paragraph.textContent = 'Long Sprint Plan content '+index;
      column.append(paragraph);
    }
    const button = document.createElement('button'); button.textContent = 'Last Sprint control';
    button.onclick = () => {window.sprintClicked=true}; column.append(button);
  })()`);

  const tones = await page.evaluate(`(() => {
    const coderColors = [...document.querySelectorAll('article[data-agent-id="coder-1"] strong')].map((el) => getComputedStyle(el).color);
    return { count: coderColors.length, unique: [...new Set(coderColors)], transparent: coderColors.includes('rgba(0, 0, 0, 0)') };
  })()`);
  assert.equal(tones.count, 15);
  assert.equal(tones.unique.length, 1, "Same agent identity keeps one deterministic color across conflicting events");
  assert.equal(tones.transparent, false, "Unreadable transparent color is rejected");

  for (const width of [760, 1024, 1440]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate("document.querySelectorAll('.coding-workspace-column').forEach(column=>column.scrollTop=0)");
    const initial = await page.evaluate(measure);
    assert.equal(initial.monitorTracks, width <= 760 ? 1 : 2, `top-level split at ${width}`);
    assert.equal(initial.rowCount, 2);
    assert.equal(initial.upperRowChildren, 0);
    assert.equal(initial.monitorCount, 2);
    assert.equal(initial.equalRows, true, `equal 2-row height at ${width}`);
    assert.equal(initial.equalMonitorCols, true, `equal 2-column monitors at ${width}`);
    assert.equal(initial.overflow, false);
    assert.equal(initial.sprintScrollable, true);
    assert.equal(initial.activityScrollable, true);
    assert.equal(initial.watcherScrollable, true);
    assert.equal(initial.pageHeaderAboveBoth, true);
    assert.equal(initial.gitCountInColumnHeader, 0);
    assert.equal(initial.gitVisible, true);
    assert.equal(initial.gitRight, true);

    await page.evaluate("document.querySelectorAll('.workspace-monitor-content').forEach(el => el.scrollTop = 1e6)");
    const scrolled = await page.evaluate(`(() => {
      const contents = [...document.querySelectorAll('.workspace-monitor-content')];
      return { actScroll: contents[0].scrollTop, watScroll: contents[1].scrollTop, agentColScroll: document.querySelector('.coding-workspace-agent').scrollTop };
    })()`);
    assert.ok(scrolled.actScroll > 0, "Agents Activity scrolls internally");
    assert.ok(scrolled.watScroll > 0, "Watcher scrolls internally");
    assert.equal(scrolled.agentColScroll, 0, "Scrolling monitor content does not scroll the outer column");

    await page.evaluate("document.querySelector('.coding-sprint-plan').scrollTop = 500");
    await page.wait("document.querySelector('.coding-sprint-plan').scrollTop > 0");
    await page.click("document.querySelector('.coding-sprint-plan > button:last-child')");
    assert.equal(await page.evaluate("window.sprintClicked"), true);
  }

  // Verify real CodingPage project switching & useProjectEventStream isolation
  await page.evaluate("window.setCodingProject('PROJECT-OTHER')");
  await page.wait("window.streamOpened === 'PROJECT-OTHER' && document.querySelector('.coding-workspace-shell')?.getAttribute('data-project-id') === 'PROJECT-OTHER' && document.querySelectorAll('.coding-workspace-empty').length === 2");
  await page.evaluate(`(() => {
    window.activeStream.onEvent({ event_id: 'foreign-1', event_type: 'agent.activity', project_id: 'PROJECT-NODEFORGE', payload: { agent_id: 'coder-1', summary: 'Should be filtered' } });
    window.activeStream.onEvent({ event_id: 'foreign-w', event_type: 'watcher.file_indexed', project_id: 'PROJECT-NODEFORGE', payload: { activity: ['foreign.js'] } });
    window.activeStream.onError();
  })()`);
  await page.wait("document.querySelector('.workspace-monitor-indicator.is-error')?.textContent === 'Disconnected'");
  const isolated = await page.evaluate(`(() => ({
    closedStreamProject: window.closedStreamProject,
    streamCalls: window.streamCalls,
    emptyCount: document.querySelectorAll('.coding-workspace-empty').length,
    indicatorText: document.querySelector('.workspace-monitor-indicator')?.textContent
  }))()`);
  assert.equal(isolated.closedStreamProject, "PROJECT-NODEFORGE");
  assert.deepEqual(isolated.streamCalls, ["PROJECT-NODEFORGE", "PROJECT-OTHER"]);
  assert.equal(isolated.emptyCount, 2, "Previous project events are reset and foreign stream events are ignored");
  assert.equal(isolated.indicatorText, "Disconnected");
});
