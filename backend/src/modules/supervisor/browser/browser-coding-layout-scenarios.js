// Verifies approved layout behavior through measured Chromium geometry and actual interactive controls.
import assert from "node:assert/strict";

// Creates enough Sprint content to exercise each column's independent scrolling boundary.
async function prepare(page) {
  await page.waitForFunction(() => document.querySelectorAll(".coding-agent-monitor").length === 7 && window.layoutFixture.gitProjects.length === 1);
  await page.evaluate(() => {
    const column = document.querySelector(".coding-sprint-plan");
    if (column.querySelector("[data-layout-end]")) return;
    for (let index = 0; index < 60; index++) { const paragraph = document.createElement("p"); paragraph.textContent = `Long Sprint Plan content ${index}`; column.append(paragraph); }
    const button = document.createElement("button"); button.dataset.layoutEnd = "true"; button.textContent = "Last Sprint control";
    button.onclick = () => { window.layoutFixture.sprintClicked = true; }; column.append(button);
  });
}

// Measures sticky header geometry after browser layout has committed the independent scroll.
async function scrollColumn(page, selector, end = false) {
  await page.evaluate(({ selector, end }) => { document.querySelector(selector).scrollTop = end ? 1e7 : 500; }, { selector, end });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate((selector) => {
    const column = document.querySelector(selector); const rect = column.getBoundingClientRect(); const header = column.querySelector(".coding-workspace-column-header").getBoundingClientRect();
    return { scroll: column.scrollTop, local: Math.abs(header.top - rect.top) < 2, bottom: rect.bottom, headerBottom: header.bottom };
  }, selector);
}

// Implements the five immutable ticket layout assertions without replacing browser behavior with source regexes.
export async function verifyCodingLayoutAssertion(index, page) {
  await prepare(page);
  await page.evaluate(() => document.querySelectorAll(".coding-workspace-column").forEach((column) => { column.scrollTop = 0; }));
  if (index === 17 || index === 21) {
    for (const selector of [".coding-sprint-plan", ".coding-workspace-agent"]) {
      const other = selector === ".coding-sprint-plan" ? ".coding-workspace-agent" : ".coding-sprint-plan";
      const result = await scrollColumn(page, selector, index === 21);
      assert.ok(result.scroll > 0); assert.ok(result.local, "Header stays pinned inside its own column");
      assert.equal(await page.locator(other).evaluate((column) => column.scrollTop), 0);
      await page.locator(selector).evaluate((column) => { column.scrollTop = 0; });
    }
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".coding-workspace-monitor")).gridTemplateColumns.split(" ").length), page.viewportSize().width <= 760 ? 1 : 2);
  } else if (index === 18) {
    await scrollColumn(page, ".coding-workspace-agent", true);
    assert.deepEqual(await page.evaluate(() => window.layoutFixture.gitProjects), ["PROJECT-NODEFORGE"]);
    assert.equal(await page.evaluate(() => {
      const column = document.querySelector(".coding-workspace-agent").getBoundingClientRect(); const header = document.querySelector(".coding-workspace-agent .coding-workspace-column-header").getBoundingClientRect(); const git = document.querySelector(".workspace-git-status").getBoundingClientRect();
      return git.width > 0 && git.top >= column.top && git.bottom <= column.bottom && Math.abs(git.right - header.right) < 2;
    }), true);
  } else if (index === 19) {
    const geometry = await scrollColumn(page, ".coding-workspace-agent", true);
    const rect = await page.locator(".coding-agent-monitor:last-child > div:last-child").boundingBox();
    assert.ok(rect && rect.y >= geometry.headerBottom && rect.y + rect.height <= geometry.bottom + 1);
    await page.locator(".coding-agent-monitor:last-child button").click();
    assert.equal(await page.evaluate(() => window.layoutFixture.closedPanels.at(-1)?.agentId), "coder-6");
    await page.locator("[data-layout-end]").click();
    assert.equal(await page.evaluate(() => window.layoutFixture.sprintClicked), true);
  } else if (index === 20) {
    const layout = await page.evaluate(() => {
      const list = document.querySelector(".coding-workspace-list"); const column = document.querySelector(".coding-workspace-agent"); const panels = [...list.children];
      return { tracks: getComputedStyle(list).gridTemplateColumns.split(" ").length, firstRow: panels.filter((panel) => Math.abs(panel.offsetTop - panels[0].offsetTop) < 2).length, overflow: column.scrollWidth > column.clientWidth || document.documentElement.scrollWidth > innerWidth, count: panels.length };
    });
    assert.equal(layout.count, 7); assert.equal(layout.overflow, false); assert.equal(layout.firstRow, layout.tracks); assert.ok(layout.tracks >= 1 && layout.tracks <= 3);
    assert.equal(layout.tracks, page.viewportSize().width >= 1440 ? 3 : page.viewportSize().width <= 400 ? 1 : page.viewportSize().width <= 760 ? 2 : 1);
  } else throw new Error("No layout scenario implements this assertion.");
}
