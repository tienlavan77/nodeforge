<!--
Business purpose: Provides Part 5 of 5 of the complete, verbatim git diff between base commit 131a628f042a27f0098df3dfb62f03a1a50223b4 and review commit 452c3c353b46c8f0b92841547177a49b46d77383 for PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1).
Technical description: Generated directly from git diff 131a628f042a27f0098df3dfb62f03a1a50223b4..452c3c353b46c8f0b92841547177a49b46d77383 without manual hunk editing; bounded to <= 250 physical lines.
-->
# Scoped Unified Patch (Part 5/5: Browser Integration Test (Lines 151-296)) — PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1)

- **Base Commit SHA**: `131a628f042a27f0098df3dfb62f03a1a50223b4` | **Review Commit SHA**: `452c3c353b46c8f0b92841547177a49b46d77383` (`tree_sha: 89f1468c05c86d280b6e0dc60a1fe25079d25ff9`)
- **Manifest SHA-256**: `sha256:ab16b7dc1dbf31159ec783c18d513a1bae0f856cbea6b49c5eb8892a2e2b1316` | **Files in Part 5**: `ui/nextjs/tests/coding-workspace-layout-browser.test.js` (diff lines 151–296)
- **All Patch Parts**: `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch.md` (Part 1), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part2.md` (Part 2), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part3.md` (Part 3), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part4.md` (Part 4), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part5.md` (Part 5)

```diff
+                              timestamp: '2026-11-02T10:01:0' + idx + '.000Z',
+                              payload: { activity: Array.from({ length: 8 }, (_, sub) => 'src/module-' + idx + '-' + sub + '.js') }
+                            }))
+                          }
+                        }
+                      });
+                      opts.onEvent?.({
+                        event_id: 'wat-live',
+                        event_type: 'watcher.file_indexed',
+                        project_id: opts.projectId,
+                        timestamp: '2026-11-02T10:01:09.000Z',
+                        payload: { activity: Array.from({ length: 8 }, (_, sub) => 'src/live-' + sub + '.js') }
+                      });
+                    }
+                  }, 10);
+                  return { close() { window.closedStreamProject = opts.projectId; } };
+                }
+              };
+            }
+          `,
+          loader: "js"
+        }));
+      }
+    }]
+  });
   const styles = await readFile(new URL("../app/styles/workspace-monitors.css", import.meta.url), "utf8");
   const homeStyles = await readFile(new URL("../app/styles/home-workspace.css", import.meta.url), "utf8");
   const convStyles = await readFile(new URL("../app/styles/home-conversation.css", import.meta.url), "utf8");
@@ -73,7 +173,7 @@ test("Coding headers stay column-local beneath the shared page header and the ag
   const browser = await launchProjectChromium(join(directory, "profile"));
   context.after(() => browser.close());
   const page = await browser.page(`http://127.0.0.1:${server.address().port}/`);
-  await page.wait("document.querySelectorAll('.coding-agent-monitor').length === 7 && window.gitProjects.length === 1");
+  await page.wait("document.querySelectorAll('.coding-workspace-monitor-column').length === 2 && document.querySelectorAll('.workspace-monitor-content article').length >= 60 && window.gitProjects.length >= 1");
   await page.evaluate(`(() => {
     const column = document.querySelector('.coding-sprint-plan');
     for(let index=0;index<60;index++) {
@@ -83,58 +183,66 @@ test("Coding headers stay column-local beneath the shared page header and the ag
     const button = document.createElement('button'); button.textContent = 'Last Sprint control';
     button.onclick = () => {window.sprintClicked=true}; column.append(button);
   })()`);
-  for (const [width, expectedTracks] of [[375, 1], [760, 2], [768, 1], [1440, 3]]) {
+
+  const tones = await page.evaluate(`(() => {
+    const coderColors = [...document.querySelectorAll('article[data-agent-id="coder-1"] strong')].map((el) => getComputedStyle(el).color);
+    return { count: coderColors.length, unique: [...new Set(coderColors)], transparent: coderColors.includes('rgba(0, 0, 0, 0)') };
+  })()`);
+  assert.equal(tones.count, 15);
+  assert.equal(tones.unique.length, 1, "Same agent identity keeps one deterministic color across conflicting events");
+  assert.equal(tones.transparent, false, "Unreadable transparent color is rejected");
+
+  for (const width of [760, 1024, 1440]) {
     await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
     await page.evaluate("document.querySelectorAll('.coding-workspace-column').forEach(column=>column.scrollTop=0)");
-    await page.wait(`getComputedStyle(document.querySelector('.coding-workspace-list')).gridTemplateColumns.split(' ').length === ${expectedTracks}`);
     const initial = await page.evaluate(measure);
     assert.equal(initial.monitorTracks, width <= 760 ? 1 : 2, `top-level split at ${width}`);
-    assert.equal(initial.firstRow, expectedTracks);
-    assert.equal(initial.panelCount, 7);
+    assert.equal(initial.rowCount, 2);
+    assert.equal(initial.upperRowChildren, 0);
+    assert.equal(initial.monitorCount, 2);
+    assert.equal(initial.equalRows, true, `equal 2-row height at ${width}`);
+    assert.equal(initial.equalMonitorCols, true, `equal 2-column monitors at ${width}`);
     assert.equal(initial.overflow, false);
-    assert.equal(initial.vertical, true);
+    assert.equal(initial.sprintScrollable, true);
+    assert.equal(initial.activityScrollable, true);
+    assert.equal(initial.watcherScrollable, true);
     assert.equal(initial.pageHeaderAboveBoth, true);
     assert.equal(initial.gitCountInColumnHeader, 0);
     assert.equal(initial.gitVisible, true);
     assert.equal(initial.gitRight, true);
-    for (const selector of ['.coding-sprint-plan', '.coding-workspace-agent']) {
-      const other = selector === '.coding-sprint-plan' ? '.coding-workspace-agent' : '.coding-sprint-plan';
-      await page.evaluate(`document.querySelector('${selector}').scrollTop=500`);
-      await page.wait(`document.querySelector('${selector}').scrollTop > 0`);
-      const result = await page.evaluate(`(() => {
-        const column=document.querySelector('${selector}'); const header=column.querySelector('.coding-workspace-column-header');
-        return {top:header.getBoundingClientRect().top,columnTop:column.getBoundingClientRect().top,other:document.querySelector('${other}').scrollTop};
-      })()`);
-      assert.ok(Math.abs(result.top - result.columnTop) < 2, `local sticky header at ${width}`);
-      assert.equal(result.other, 0, "scrolling one column does not move its neighbor");
-      await page.evaluate(`document.querySelector('${selector}').scrollTop=0`);
-    }
-    await page.evaluate("document.querySelector('.coding-workspace-agent').scrollTop=1e7");
-    const bottom = await page.evaluate(measure);
-    assert.ok(bottom.scrollTop > 500);
-    assert.equal(bottom.mainScroll, 0);
-    assert.equal(bottom.pageScroll, 0);
-    assert.equal(bottom.gitVisible, true);
-    assert.ok(Math.abs(bottom.headerTop - bottom.columnTop) < 2);
-    assert.equal(await page.evaluate(`(() => {
-      const column=document.querySelector('.coding-workspace-agent'); const last=column.querySelector('.coding-agent-monitor:last-child > div:last-child');
-      const rect=last.getBoundingClientRect();return rect.bottom <= column.getBoundingClientRect().bottom && rect.top >= column.querySelector('.coding-workspace-column-header').getBoundingClientRect().bottom;
-    })()`), true, "last activity can be read below the header");
-    // System chrome orders minimize before close, so target the explicit close control for the identity contract.
-    await page.click("document.querySelector('.coding-agent-monitor:last-child button[aria-label^=\"Close agent panel\"]')");
-    assert.equal(await page.evaluate("window.closedPanels.at(-1).agentId"), "coder-6");
-    assert.equal(await page.evaluate(`(() => {
-      const button=document.querySelector('.coding-agent-monitor:last-child button[aria-label^="Close agent panel"]');const rect=button.getBoundingClientRect();
-      return document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===button;
-    })()`), true, "close control is not hidden by the sticky header");
+
+    await page.evaluate("document.querySelectorAll('.workspace-monitor-content').forEach(el => el.scrollTop = 1e6)");
+    const scrolled = await page.evaluate(`(() => {
+      const contents = [...document.querySelectorAll('.workspace-monitor-content')];
+      return { actScroll: contents[0].scrollTop, watScroll: contents[1].scrollTop, agentColScroll: document.querySelector('.coding-workspace-agent').scrollTop };
+    })()`);
+    assert.ok(scrolled.actScroll > 0, "Agents Activity scrolls internally");
+    assert.ok(scrolled.watScroll > 0, "Watcher scrolls internally");
+    assert.equal(scrolled.agentColScroll, 0, "Scrolling monitor content does not scroll the outer column");
+
+    await page.evaluate("document.querySelector('.coding-sprint-plan').scrollTop = 500");
+    await page.wait("document.querySelector('.coding-sprint-plan').scrollTop > 0");
     await page.click("document.querySelector('.coding-sprint-plan > button:last-child')");
     assert.equal(await page.evaluate("window.sprintClicked"), true);
   }
-  await page.evaluate("document.querySelector('.conversation-sidebar').classList.remove('is-collapsed')");
-  await page.wait("getComputedStyle(document.querySelector('.coding-workspace-list')).gridTemplateColumns.split(' ').length === 2");
-  const expanded = await page.evaluate(measure);
-  assert.equal(expanded.firstRow, 2);
-  assert.equal(expanded.overflow, false);
-  assert.equal(expanded.monitorTracks, 2);
-  assert.deepEqual(await page.evaluate("window.gitProjects"), ["PROJECT-NODEFORGE"]);
+
+  // Verify real CodingPage project switching & useProjectEventStream isolation
+  await page.evaluate("window.setCodingProject('PROJECT-OTHER')");
+  await page.wait("window.streamOpened === 'PROJECT-OTHER' && document.querySelector('.coding-workspace-shell')?.getAttribute('data-project-id') === 'PROJECT-OTHER' && document.querySelectorAll('.coding-workspace-empty').length === 2");
+  await page.evaluate(`(() => {
+    window.activeStream.onEvent({ event_id: 'foreign-1', event_type: 'agent.activity', project_id: 'PROJECT-NODEFORGE', payload: { agent_id: 'coder-1', summary: 'Should be filtered' } });
+    window.activeStream.onEvent({ event_id: 'foreign-w', event_type: 'watcher.file_indexed', project_id: 'PROJECT-NODEFORGE', payload: { activity: ['foreign.js'] } });
+    window.activeStream.onError();
+  })()`);
+  await page.wait("document.querySelector('.workspace-monitor-indicator.is-error')?.textContent === 'Disconnected'");
+  const isolated = await page.evaluate(`(() => ({
+    closedStreamProject: window.closedStreamProject,
+    streamCalls: window.streamCalls,
+    emptyCount: document.querySelectorAll('.coding-workspace-empty').length,
+    indicatorText: document.querySelector('.workspace-monitor-indicator')?.textContent
+  }))()`);
+  assert.equal(isolated.closedStreamProject, "PROJECT-NODEFORGE");
+  assert.deepEqual(isolated.streamCalls, ["PROJECT-NODEFORGE", "PROJECT-OTHER"]);
+  assert.equal(isolated.emptyCount, 2, "Previous project events are reset and foreign stream events are ignored");
+  assert.equal(isolated.indicatorText, "Disconnected");
 });
```
