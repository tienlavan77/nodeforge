/**
 * Browser verification scenario for the Architecture Manager Ideas persistent floating monitor.
 * Exercises the real bundled ProjectWorkspace and ArchitectureWorkspace components in Chromium to
 * verify workspace-monitor-header controls, viewport-constrained pointer dragging, native resize
 * with localStorage layout persistence across reloads, legacy layout fallback, in-memory draft
 * survival across minimize/close/conversation/agent transitions, and strict content privacy.
 */
import assert from "node:assert/strict";
export { createBrowserFixture } from "./ideas-monitor-fixture.mjs";

const LAYOUT_KEY = "nodeforge:workspace-monitor-layout:home";

/**
 * Reset browser storage and reload the AM workspace so each scenario starts from a clean state.
 */
async function resetWorkspace(page, origin, initialLayout = null) {
  await page.goto(origin);
  await page.evaluate(({ key, layout }) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    if (layout !== null) window.localStorage.setItem(key, JSON.stringify(layout));
    window.consoleLogs = [];
    window.storageWrites = [];
  }, { key: LAYOUT_KEY, layout: initialLayout });
  await page.reload();
  await page.getByRole("button", { name: "Ý tưởng", exact: true }).waitFor();
  await page.getByRole("heading", { name: "First conversation", exact: true }).waitFor();
}

/**
 * Open the Ideas floating monitor from the dock if it is not already visible.
 */
async function openIdeasMonitor(page) {
  const dockBtn = page.locator(".workspace-monitor-dock").getByRole("button", { name: "Ý tưởng", exact: true });
  await dockBtn.waitFor();
  if ((await dockBtn.getAttribute("aria-pressed")) !== "true") {
    await dockBtn.click();
  }
  const panel = page.getByRole("region", { name: "Ý tưởng", exact: true });
  await panel.waitFor();
  return { dockBtn, panel };
}

/**
 * Perform a real pointer drag gesture on the Ideas monitor header using viewport-safe pointer coordinates.
 */
async function dragHeader(page, header, offsetX, targetX, targetY) {
  const box = await header.boundingBox();
  const startX = Math.round(box.x + offsetX);
  const startY = Math.round(box.y + box.height / 2);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(Math.round(targetX), Math.round(targetY), { steps: 5 });
  await page.mouse.up();
}

/**
 * Exercise the user-visible native resize grip at the bottom-right corner of the Ideas floating
 * monitor so browser verification proves real pointer resizing rather than inline style assignment.
 * Computes the panel bounding box, positions the pointer inside the native CSS resize handle,
 * and drags by the requested horizontal and vertical deltas across multiple pointer move steps.
 */
async function dragResizeHandle(page, panel, deltaX, deltaY) {
  const box = await panel.boundingBox();
  const startX = Math.round(box.x + box.width - 4);
  const startY = Math.round(box.y + box.height - 4);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 6 });
  await page.mouse.up();
}

/**
 * Open the conversation drawer on narrow mobile viewports and close overlapping system monitors.
 */
async function openNavigationDrawerIfNeeded(page, viewport) {
  for (const name of ["Close Watcher monitor", "Close Agent monitor"]) {
    const closeBtn = page.getByRole("button", { name, exact: true });
    if (await closeBtn.isVisible()) await closeBtn.click();
  }
  if (viewport < 640) {
    await page.locator('.conversation-mobile-rail button[aria-label="Open conversations sidebar"]').evaluate((btn) => btn.click());
  }
}

export const browserAssertions = {
  "The AM Ideas window uses workspace-monitor and workspace-monitor-header with the approved title and controls, and pointer dragging keeps the window within the viewport.": async ({ page, viewport, origin }) => {
    await resetWorkspace(page, origin);
    const { panel } = await openIdeasMonitor(page);
    assert.equal(await panel.evaluate((el) => el.classList.contains("workspace-monitor") && el.classList.contains("ideas-panel")), true);
    const header = panel.locator(".workspace-monitor-header");
    await header.waitFor();
    assert.equal(await header.locator("strong").textContent(), "Ý tưởng");
    const minBtn = header.getByRole("button", { name: /Thu gọn Ý tưởng|Mở rộng Ý tưởng/ });
    const closeBtn = header.getByRole("button", { name: "Đóng Ý tưởng", exact: true });
    assert.equal(await minBtn.textContent(), "−");
    assert.equal(await closeBtn.textContent(), "×");

    await dragHeader(page, header, 120, 2, 2);
    let bounds = await panel.boundingBox();
    assert.equal(Math.round(bounds.x), 0);
    assert.equal(Math.round(bounds.y), 0);

    await dragHeader(page, header, 20, 48, 65);
    bounds = await panel.boundingBox();
    assert.ok(Math.round(bounds.x) >= 25 && Math.round(bounds.x) <= 30);
    assert.ok(Math.round(bounds.y) >= 35);

    const innerHeight = await page.evaluate(() => window.innerHeight);
    await dragHeader(page, header, 15, viewport - 4, innerHeight - 4);
    bounds = await panel.boundingBox();
    assert.ok(bounds.x >= 0 && Math.round(bounds.x + bounds.width) <= viewport);
    assert.ok(bounds.y >= 0 && Math.round(bounds.y + bounds.height) <= innerHeight);
  },

  "Minimize hides the Ideas body with is-minimized, expand restores it, and close and dock toggles keep visibility and aria-pressed synchronized.": async ({ page, origin }) => {
    await resetWorkspace(page, origin);
    const dockBtn = page.locator(".workspace-monitor-dock").getByRole("button", { name: "Ý tưởng", exact: true });
    assert.equal(await dockBtn.getAttribute("aria-pressed"), "false");

    const { panel } = await openIdeasMonitor(page);
    assert.equal(await dockBtn.getAttribute("aria-pressed"), "true");
    await panel.getByLabel("Ý tưởng mới", { exact: true }).waitFor();

    const header = panel.locator(".workspace-monitor-header");
    const minBtn = header.getByRole("button", { name: /Thu gọn Ý tưởng|Mở rộng Ý tưởng/ });
    assert.equal(await minBtn.textContent(), "−");
    await minBtn.click();

    assert.equal(await panel.evaluate((el) => el.classList.contains("is-minimized")), true);
    assert.equal(await minBtn.textContent(), "□");
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).count(), 0);
    assert.equal(await dockBtn.getAttribute("aria-pressed"), "true");

    await minBtn.click();
    assert.equal(await panel.evaluate((el) => el.classList.contains("is-minimized")), false);
    assert.equal(await minBtn.textContent(), "−");
    await panel.getByLabel("Ý tưởng mới", { exact: true }).waitFor();

    await header.getByRole("button", { name: "Đóng Ý tưởng", exact: true }).click();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await dockBtn.getAttribute("aria-pressed"), "false");

    await dockBtn.click();
    assert.equal(await panel.isVisible(), true);
    assert.equal(await dockBtn.getAttribute("aria-pressed"), "true");

    await dockBtn.click();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await dockBtn.getAttribute("aria-pressed"), "false");
  },

  "The expanded Ideas window supports native resize in both directions, and changed x, y, width, height, visible, and minimized values survive reload under the AM layout key.": async ({ page, origin }) => {
    await resetWorkspace(page, origin);
    const { dockBtn, panel } = await openIdeasMonitor(page);
    assert.equal(await panel.evaluate((el) => getComputedStyle(el).resize), "both");

    const header = panel.locator(".workspace-monitor-header");
    await dragHeader(page, header, 120, 2, 2);
    await dragHeader(page, header, 20, 38, 49);

    const initialBox = await panel.boundingBox();
    const initialW = Math.round(initialBox.width);
    const initialH = Math.round(initialBox.height);
    await dragResizeHandle(page, panel, -55, -70);

    const resizedBox = await panel.boundingBox();
    const resizedW = Math.round(resizedBox.width);
    const resizedH = Math.round(resizedBox.height);
    assert.ok(resizedW !== initialW && resizedW < initialW);
    assert.ok(resizedH !== initialH && resizedH < initialH);

    await page.waitForFunction(({ key, w, h }) => {
      const saved = JSON.parse(window.localStorage.getItem(key) || "null");
      return saved?.ideas && saved.ideas.width === w && saved.ideas.height === h && saved.ideas.visible === true;
    }, { key: LAYOUT_KEY, w: resizedW, h: resizedH });

    await header.getByRole("button", { name: /Thu gọn Ý tưởng|Mở rộng Ý tưởng/ }).click();
    assert.equal(await panel.evaluate((el) => getComputedStyle(el).resize), "none");
    await page.waitForFunction((key) => {
      const saved = JSON.parse(window.localStorage.getItem(key) || "null");
      return saved?.ideas?.minimized === true;
    }, LAYOUT_KEY);

    const beforeReload = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key)).ideas, LAYOUT_KEY);
    assert.equal(beforeReload.visible, true);
    assert.equal(beforeReload.minimized, true);
    assert.equal(beforeReload.width, resizedW);
    assert.equal(beforeReload.height, resizedH);

    await page.reload();
    await dockBtn.waitFor();
    assert.equal(await dockBtn.getAttribute("aria-pressed"), "true");
    await panel.waitFor();
    assert.equal(await panel.evaluate((el) => el.classList.contains("is-minimized")), true);
    await panel.locator(".workspace-monitor-header").getByRole("button", { name: /Thu gọn Ý tưởng|Mở rộng Ý tưởng/ }).click();
    const afterBox = await panel.boundingBox();
    assert.equal(Math.round(afterBox.x), beforeReload.x);
    assert.equal(Math.round(afterBox.y), beforeReload.y);
    assert.equal(Math.round(afterBox.width), resizedW);
    assert.equal(Math.round(afterBox.height), resizedH);
  },

  "An unfinished Ideas draft survives minimize, close and reopen, and real AM conversation and agent changes during the same session.": async ({ page, viewport, origin }) => {
    await resetWorkspace(page, origin);
    const { dockBtn, panel } = await openIdeasMonitor(page);
    await panel.getByText("Existing project idea", { exact: true }).waitFor();
    await panel.locator('[data-idea-id="idea-1"]').getByRole("button", { name: "Sửa", exact: true }).click();
    await panel.getByLabel("Sửa nội dung", { exact: true }).fill("Draft edit across AM changes");
    await panel.getByLabel("Ý tưởng mới", { exact: true }).fill("Draft quick across AM changes");

    const minBtn = panel.locator(".workspace-monitor-header").getByRole("button", { name: /Thu gọn Ý tưởng|Mở rộng Ý tưởng/ });
    await minBtn.click();
    assert.equal(await panel.evaluate((el) => el.classList.contains("is-minimized")), true);
    await minBtn.click();
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).inputValue(), "Draft quick across AM changes");
    assert.equal(await panel.getByLabel("Sửa nội dung", { exact: true }).inputValue(), "Draft edit across AM changes");

    await panel.locator(".workspace-monitor-header").getByRole("button", { name: "Đóng Ý tưởng", exact: true }).click();
    assert.equal(await panel.isVisible(), false);
    await dockBtn.click();
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).inputValue(), "Draft quick across AM changes");
    assert.equal(await panel.getByLabel("Sửa nội dung", { exact: true }).inputValue(), "Draft edit across AM changes");

    await panel.locator(".workspace-monitor-header").getByRole("button", { name: "Đóng Ý tưởng", exact: true }).click();
    await openNavigationDrawerIfNeeded(page, viewport);
    await page.getByRole("button", { name: "Second conversation", exact: true }).click();
    await page.getByRole("heading", { name: "Second conversation", exact: true }).waitFor();
    await page.locator(".claude-sidebar-architecture > summary").click();
    const secondAgent = page.getByRole("option", { name: /Second agent/ });
    await secondAgent.click();
    assert.equal(await secondAgent.getAttribute("aria-selected"), "true");
    if (viewport < 640) await page.keyboard.press("Escape");

    await openIdeasMonitor(page);
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).inputValue(), "Draft quick across AM changes");
    assert.equal(await panel.getByLabel("Sửa nội dung", { exact: true }).inputValue(), "Draft edit across AM changes");
  },

  "Legacy AM layouts with no Ideas entry or partial Ideas entries restore safe defaults while preserving usable Watcher and Agent activity windows.": async ({ page, viewport, origin }) => {
    await resetWorkspace(page, origin, {
      watcher: { x: 12, y: 16, width: 280, height: 200, visible: true, minimized: false },
      agent: { x: 20, y: 40, width: 280, height: 200, visible: true, minimized: false },
    });
    const dock = page.locator(".workspace-monitor-dock");
    const ideasBtn = dock.getByRole("button", { name: "Ý tưởng", exact: true });
    const watcherRegion = page.getByRole("region", { name: "Watcher monitor", exact: true });
    const agentRegion = page.getByRole("region", { name: "Agent activity monitor", exact: true });
    await watcherRegion.waitFor();
    await agentRegion.waitFor();
    assert.equal(await ideasBtn.getAttribute("aria-pressed"), "false");

    await openIdeasMonitor(page);
    const panel = page.getByRole("region", { name: "Ý tưởng", exact: true });
    const box = await panel.boundingBox();
    assert.ok(box.x >= 0 && Math.round(box.x + box.width) <= viewport);

    await resetWorkspace(page, origin, {
      watcher: { x: 14, y: 18, width: 270, height: 190, visible: true, minimized: false },
      agent: { x: 22, y: 44, width: 270, height: 190, visible: true, minimized: false },
      ideas: { visible: true },
    });
    await watcherRegion.waitFor();
    await agentRegion.waitFor();
    await panel.waitFor();
    assert.equal(await ideasBtn.getAttribute("aria-pressed"), "true");
    assert.equal(await panel.evaluate((el) => el.classList.contains("is-minimized")), false);
    const partialBox = await panel.boundingBox();
    assert.ok(partialBox.width >= 220 && Math.round(partialBox.x + partialBox.width) <= viewport);
  },

  "Typing and editing sentinel idea content, moving and resizing the window, toggling controls, and switching conversations never writes that content to browser storage or console logs.": async ({ page, viewport, origin }) => {
    const sentinelQuick = "SENTINEL_QUICK_PRIVATE_99281";
    const sentinelEdit = "SENTINEL_EDIT_PRIVATE_88412";
    await resetWorkspace(page, origin);
    const { dockBtn, panel } = await openIdeasMonitor(page);
    await panel.getByText("Existing project idea", { exact: true }).waitFor();
    await panel.getByLabel("Ý tưởng mới", { exact: true }).fill(sentinelQuick);
    await panel.locator('[data-idea-id="idea-1"]').getByRole("button", { name: "Sửa", exact: true }).click();
    await panel.getByLabel("Sửa nội dung", { exact: true }).fill(sentinelEdit);

    const header = panel.locator(".workspace-monitor-header");
    await dragHeader(page, header, 80, 30, 80);
    await dragResizeHandle(page, panel, -40, -50);
    await header.getByRole("button", { name: /Thu gọn Ý tưởng|Mở rộng Ý tưởng/ }).click();
    await header.getByRole("button", { name: /Thu gọn Ý tưởng|Mở rộng Ý tưởng/ }).click();
    await header.getByRole("button", { name: "Đóng Ý tưởng", exact: true }).click();
    await dockBtn.click();

    await panel.locator(".workspace-monitor-header").getByRole("button", { name: "Đóng Ý tưởng", exact: true }).click();
    await openNavigationDrawerIfNeeded(page, viewport);
    await page.getByRole("button", { name: "Second conversation", exact: true }).click();
    await page.getByRole("heading", { name: "Second conversation", exact: true }).waitFor();

    const leakReport = await page.evaluate(({ s1, s2, key }) => {
      const localDump = JSON.stringify(Object.entries(window.localStorage));
      const sessionDump = JSON.stringify(Object.entries(window.sessionStorage));
      const writesDump = JSON.stringify(window.storageWrites);
      const logsDump = JSON.stringify(window.consoleLogs);
      const layoutRecord = JSON.parse(window.localStorage.getItem(key) || "null");
      return {
        leaked: [localDump, sessionDump, writesDump, logsDump].some((blob) => blob.includes(s1) || blob.includes(s2)),
        ideasKeys: layoutRecord?.ideas ? Object.keys(layoutRecord.ideas).sort() : [],
      };
    }, { s1: sentinelQuick, s2: sentinelEdit, key: LAYOUT_KEY });

    assert.equal(leakReport.leaked, false);
    assert.deepEqual(leakReport.ideasKeys, ["height", "minimized", "visible", "width", "x", "y"]);
  },
};
