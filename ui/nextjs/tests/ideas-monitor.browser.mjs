/**
 * Browser verification scenario for the Architecture Manager Ideas persistent floating monitor.
 * Exercises the real bundled ProjectWorkspace and ArchitectureWorkspace components in Chromium to
 * verify removal of the Project identifier line, textarea padding and inherited font, right-aligned
 * fit-content submit button, 26x26 centered inline-flex header controls with hover styling,
 * minimize/expand/close/dock state transitions, in-memory draft survival across window and
 * conversation changes, localStorage privacy, and viewport usability across 375, 768, and 1440px.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  if ((await dockBtn.getAttribute("aria-pressed")) !== "true") await dockBtn.click();
  const panel = page.getByRole("region", { name: "Ý tưởng", exact: true });
  await panel.waitFor();
  return { dockBtn, panel };
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
  "The Ideas panel body renders no Project identifier line or .ideas-project element.": async ({ page, origin }) => {
    await resetWorkspace(page, origin);
    const { panel } = await openIdeasMonitor(page);
    await panel.getByText("Existing project idea", { exact: true }).waitFor();
    assert.equal(await panel.locator(".ideas-project").count(), 0);
    assert.equal(await page.locator(".ideas-project").count(), 0);
    assert.doesNotMatch(await panel.innerText(), /Project:\s*PROJECT-A/);
  },

  "Create and edit textareas have computed padding 8px 10px and inherit the interface font; the add button is right-aligned and fits its text.": async ({ page, origin }) => {
    await resetWorkspace(page, origin);
    const { panel } = await openIdeasMonitor(page);
    await panel.getByText("Existing project idea", { exact: true }).waitFor();
    await panel.locator('[data-idea-id="idea-1"]').getByRole("button", { name: "Sửa", exact: true }).click();
    await panel.getByLabel("Sửa nội dung", { exact: true }).waitFor();
    const styleCheck = await panel.evaluate((panelEl) => {
      const bodyFont = getComputedStyle(document.body).fontFamily;
      const textareas = Array.from(panelEl.querySelectorAll("textarea")).map((ta) => {
        const cs = getComputedStyle(ta);
        return { pad: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`, font: cs.fontFamily };
      });
      const btn = panelEl.querySelector(".ideas-entry-submit");
      const form = btn.closest("form");
      const btnRect = btn.getBoundingClientRect(), formRect = form.getBoundingClientRect();
      const rules = Array.from(document.styleSheets).flatMap((s) => Array.from(s.cssRules || []));
      const fitRule = rules.some((r) => r.selectorText && btn.matches(r.selectorText) && r.style.width === "fit-content" && r.style.alignSelf === "flex-end");
      return { bodyFont, textareas, alignSelf: getComputedStyle(btn).alignSelf, fitRule, btnW: btnRect.width, formW: formRect.width, rightDiff: Math.abs(formRect.right - btnRect.right) };
    });
    assert.equal(styleCheck.textareas.length, 2);
    for (const ta of styleCheck.textareas) {
      assert.equal(ta.pad, "8px 10px 8px 10px");
      assert.equal(ta.font, styleCheck.bodyFont);
    }
    assert.equal(styleCheck.alignSelf, "flex-end");
    assert.equal(styleCheck.fitRule, true);
    assert.ok(styleCheck.btnW < styleCheck.formW * 0.85 && styleCheck.rightDiff <= 2);
  },

  "Visible minimize, expand, and close controls occupy 26px by 26px boxes with centered inline-flex content, zero padding, line-height 1, and consistent hover treatment.": async ({ page, origin }) => {
    await resetWorkspace(page, origin);
    const { panel } = await openIdeasMonitor(page);
    const header = panel.locator(".workspace-monitor-header");
    const minBtn = header.getByRole("button", { name: /Thu gọn Ý tưởng|Mở rộng Ý tưởng/ });
    const inspectHeader = () => header.evaluate((headerEl) => {
      const rules = Array.from(document.styleSheets).flatMap((s) => Array.from(s.cssRules || []));
      const btnRules = rules.filter((r) => r.selectorText?.includes(".ideas-panel") && r.selectorText.includes(".workspace-monitor-header") && r.selectorText.includes("button"));
      const hasInlineFlex = btnRules.some((r) => r.style.display === "inline-flex");
      const hasHover = btnRules.some((r) => r.selectorText.includes(":hover"));
      const hasLineHeight = btnRules.some((r) => r.style.lineHeight === "1");
      const gap = parseFloat(getComputedStyle(headerEl).columnGap || getComputedStyle(headerEl).gap || "0");
      const buttons = Array.from(headerEl.querySelectorAll("button")).map((b) => {
        const cs = getComputedStyle(b), rect = b.getBoundingClientRect();
        return { w: Math.round(rect.width), h: Math.round(rect.height), flex: cs.display === "inline-flex" || cs.display === "flex", align: cs.alignItems, justify: cs.justifyContent, pad: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`, lh: cs.lineHeight === "1" || cs.lineHeight === cs.fontSize };
      });
      return { hasInlineFlex, hasHover, hasLineHeight, gapOk: gap > 0 && gap <= 10, buttons };
    });
    for (const expectedSymbol of ["−", "□"]) {
      assert.equal(await minBtn.textContent(), expectedSymbol);
      const res = await inspectHeader();
      assert.equal(res.hasInlineFlex && res.hasHover && res.hasLineHeight && res.gapOk, true);
      for (const b of res.buttons) {
        assert.deepEqual(b, { w: 26, h: 26, flex: true, align: "center", justify: "center", pad: "0px 0px 0px 0px", lh: true });
      }
      if (expectedSymbol === "−") await minBtn.click();
    }
  },

  "Minimizing Ideas and clicking either its header expand control or its dock button restores a visible, expanded body.": async ({ page, origin }) => {
    await resetWorkspace(page, origin);
    const { dockBtn, panel } = await openIdeasMonitor(page);
    const minBtn = panel.locator(".workspace-monitor-header").getByRole("button", { name: /Thu gọn Ý tưởng|Mở rộng Ý tưởng/ });
    await minBtn.click();
    assert.equal(await panel.evaluate((el) => el.classList.contains("is-minimized")), true);
    assert.equal(await panel.locator(".ideas-panel-body").count(), 0);
    await minBtn.click();
    assert.equal(await panel.evaluate((el) => el.classList.contains("is-minimized")), false);
    await panel.getByLabel("Ý tưởng mới", { exact: true }).waitFor();

    await minBtn.click();
    assert.equal(await panel.evaluate((el) => el.classList.contains("is-minimized")), true);
    await dockBtn.click();
    assert.equal(await panel.isVisible(), true);
    assert.equal(await panel.evaluate((el) => el.classList.contains("is-minimized")), false);
    assert.equal(await dockBtn.getAttribute("aria-pressed"), "true");
    await panel.getByLabel("Ý tưởng mới", { exact: true }).waitFor();
  },

  "Closing Ideas from either an expanded or minimized state resets visibility and minimization; reopening from the dock always displays the complete panel.": async ({ page, origin }) => {
    await resetWorkspace(page, origin);
    const { dockBtn, panel } = await openIdeasMonitor(page);
    const header = panel.locator(".workspace-monitor-header");
    const minBtn = header.getByRole("button", { name: /Thu gọn Ý tưởng|Mở rộng Ý tưởng/ });
    const closeBtn = header.getByRole("button", { name: "Đóng Ý tưởng", exact: true });

    await closeBtn.click();
    assert.equal(await panel.isVisible(), false);
    await dockBtn.click();
    assert.equal(await panel.isVisible(), true);
    assert.equal(await panel.evaluate((el) => el.classList.contains("is-minimized")), false);

    await minBtn.click();
    assert.equal(await panel.evaluate((el) => el.classList.contains("is-minimized")), true);
    await closeBtn.click();
    assert.equal(await panel.isVisible(), false);
    const saved = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) || "null")?.ideas, LAYOUT_KEY);
    assert.equal(saved.visible, false);
    assert.equal(saved.minimized, false);

    await dockBtn.click();
    assert.equal(await panel.isVisible(), true);
    assert.equal(await panel.evaluate((el) => el.classList.contains("is-minimized")), false);
    await panel.getByLabel("Ý tưởng mới", { exact: true }).waitFor();
  },

  "Create and edit drafts survive minimize, close and reopen, and conversation changes within the session.": async ({ page, viewport, origin }) => {
    await resetWorkspace(page, origin);
    const { dockBtn, panel } = await openIdeasMonitor(page);
    await panel.getByText("Existing project idea", { exact: true }).waitFor();
    await panel.locator('[data-idea-id="idea-1"]').getByRole("button", { name: "Sửa", exact: true }).click();
    await panel.getByLabel("Sửa nội dung", { exact: true }).fill("Draft edit across transitions");
    await panel.getByLabel("Ý tưởng mới", { exact: true }).fill("Draft quick across transitions");
    const header = panel.locator(".workspace-monitor-header");
    await header.getByRole("button", { name: /Thu gọn Ý tưởng|Mở rộng Ý tưởng/ }).click();
    await dockBtn.click();
    await header.getByRole("button", { name: "Đóng Ý tưởng", exact: true }).click();
    await openNavigationDrawerIfNeeded(page, viewport);
    await page.getByRole("button", { name: "Second conversation", exact: true }).click();
    await page.getByRole("heading", { name: "Second conversation", exact: true }).waitFor();
    if (viewport < 640) await page.keyboard.press("Escape");
    await openIdeasMonitor(page);
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).inputValue(), "Draft quick across transitions");
    assert.equal(await panel.getByLabel("Sửa nội dung", { exact: true }).inputValue(), "Draft edit across transitions");
  },

  "Ideas browser storage writes contain only approved layout state and never idea content or draft text in localStorage or sessionStorage.": async ({ page, origin }) => {
    const s1 = "SENTINEL_QUICK_O3_99281", s2 = "SENTINEL_EDIT_O3_88412";
    await resetWorkspace(page, origin);
    const { dockBtn, panel } = await openIdeasMonitor(page);
    await panel.getByText("Existing project idea", { exact: true }).waitFor();
    await panel.getByLabel("Ý tưởng mới", { exact: true }).fill(s1);
    await panel.locator('[data-idea-id="idea-1"]').getByRole("button", { name: "Sửa", exact: true }).click();
    await panel.getByLabel("Sửa nội dung", { exact: true }).fill(s2);
    const header = panel.locator(".workspace-monitor-header");
    await header.getByRole("button", { name: /Thu gọn Ý tưởng|Mở rộng Ý tưởng/ }).click();
    await dockBtn.click();
    await header.getByRole("button", { name: "Đóng Ý tưởng", exact: true }).click();
    const report = await page.evaluate(({ q, e, key }) => {
      const blobs = [window.localStorage, window.sessionStorage, window.storageWrites, window.consoleLogs].map((x) => JSON.stringify(x));
      const rec = JSON.parse(window.localStorage.getItem(key) || "null");
      return { leaked: blobs.some((b) => b.includes(q) || b.includes(e)), keys: rec?.ideas ? Object.keys(rec.ideas).sort() : [] };
    }, { q: s1, e: s2, key: LAYOUT_KEY });
    assert.equal(report.leaked, false);
    assert.deepEqual(report.keys, ["height", "minimized", "visible", "width", "x", "y"]);
  },

  "The Ideas panel and controls remain usable within the viewport at mobile, tablet, and desktop widths.": async ({ page, viewport, origin }) => {
    await resetWorkspace(page, origin);
    const { dockBtn, panel } = await openIdeasMonitor(page);
    const innerH = await page.evaluate(() => window.innerHeight);
    for (const loc of [panel, panel.locator(".workspace-monitor-header").getByRole("button", { name: "Đóng Ý tưởng", exact: true }), dockBtn]) {
      const box = await loc.boundingBox();
      assert.ok(box.x >= 0 && Math.round(box.x + box.width) <= viewport && box.y >= 0 && Math.round(box.y + box.height) <= innerH);
    }
  },

  "The committed focused test asserts the approved textarea, button, and monitor-control presentation values.": async () => {
    const testSrc = await readFile(new URL("./ideas-monitor-layout.test.mjs", import.meta.url), "utf8");
    assert.match(testSrc, /padding:\\s\*8px\\s\+10px/);
    assert.match(testSrc, /align-self:\\s\*flex-end/);
    assert.match(testSrc, /width:\\s\*fit-content/);
    assert.match(testSrc, /display:\\s\*inline-flex/);
  },

  "The committed focused test asserts the approved close and dock toggle state transitions.": async () => {
    const testSrc = await readFile(new URL("./ideas-monitor-layout.test.mjs", import.meta.url), "utf8");
    assert.match(testSrc, /visible:\\s\*false\\s\*,\\s\*minimized:\\s\*false/);
    assert.match(testSrc, /visible:\\s\*!open\\s\*\\\|\\\|\\s\*minimized\\s\*,\\s\*minimized:\\s\*false/);
  },
};
