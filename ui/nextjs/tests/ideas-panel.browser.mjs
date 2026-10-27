/**
 * Exercises the production notebook inside the real project and conversation workspace.
 * Chromium assertions cover observable CRUD, drafts, response timing, keyboard interaction,
 * viewport geometry, persisted record reloads and uninterrupted SSE transport and DOM identity.
 * The exported assertion keys are the exact immutable ticket verification contract.
 */
import assert from "node:assert/strict";
export { createBrowserFixture } from "./ideas-browser-fixture.mjs";

/** Open a clean fixture document so storage shared between assertions cannot hide regressions. */
async function open(page, origin, query = "") {
  await page.goto(origin);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(origin + (query ? "#" + query : ""));
  if (query) await page.reload();
  await page.getByRole("button", { name: "Ý tưởng", exact: true }).waitFor();
  if (!query.includes("noAgent")) await page.getByRole("heading", { name: "First conversation", exact: true }).waitFor();
  return page.getByRole("region", { name: "Ý tưởng", exact: true });
}

/** Toggle the actual dock control and await the notebook region's visible state. */
async function show(page) {
  try { await page.getByRole("button", { name: "Ý tưởng", exact: true }).click(); }
  catch (error) {
    throw new Error(error.message + "; fixture: " + await page.evaluate(() => JSON.stringify({ errors: window.fixtureErrors, text: document.body.innerText, calls: window.calls, url: location.href })), { cause: error });
  }
  const panel = page.getByRole("region", { name: "Ý tưởng", exact: true });
  try { await panel.waitFor(); }
  catch (error) {
    throw new Error(error.message + "; fixture: " + await page.evaluate(() => JSON.stringify({ errors: window.fixtureErrors, text: document.body.innerText, calls: window.calls, dock: document.querySelector("[aria-controls]")?.outerHTML, panel: document.querySelector(".ideas-panel")?.outerHTML })), { cause: error });
  }
  return panel;
}

/** Capture a record through native form submission and wait for authoritative save confirmation. */
async function create(page, content) {
  const panel = page.getByRole("region", { name: "Ý tưởng", exact: true });
  await panel.getByLabel("Ý tưởng mới", { exact: true }).fill(content);
  await panel.getByRole("button", { name: "Thêm ý tưởng", exact: true }).click();
  await panel.getByText("Đã lưu", { exact: true }).waitFor();
  await panel.locator("li").filter({ hasText: content }).waitFor();
}

/** Confirm Ideas operations never cross into conversation, approval, ticket, plan, sprint or execution writes. */
async function assertOnlyIdeasWrites(page) {
  const forbidden = await page.evaluate(() => window.calls.filter(call => call.method !== "GET" && !call.path.includes("/ideas")));
  assert.deepEqual(forbidden, []);
}

/** Emit a genuine project event through the controlled external EventSource transport. */
async function chunk(page, text) {
  await page.evaluate(text => window.emit("conversation.message.delta", {
    conversation_id: "CONV-1", agent_id: "AM-1", correlation_id: "reply-1", message_id: "message-1", chunk: text
  }), text);
}

/** Use real responsive navigation to expose conversation and agent controls on narrow screens. */
async function navigation(page, viewport) {
  for (const name of ["Close Watcher monitor", "Close Agent monitor"]) {
    const close = page.getByRole("button", { name, exact: true });
    if (await close.isVisible()) await close.click();
  }
  // Existing Architecture styles hide this unrelated launcher; invoke its real DOM handler to open the production drawer.
  if (viewport < 640) await page.locator('.conversation-mobile-rail button[aria-label="Open conversations sidebar"]').evaluate(button => button.click());
}

/** Reach an actionable control using sequential keyboard focus rather than pointer activation. */
async function tabTo(page, locator) {
  for (let index = 0; index < 60; index++) {
    if (await locator.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Keyboard could not reach labelled control");
}

/** Map each approved assertion to executable production-component interaction and failure checks. */
export const browserAssertions = {
  "The Ideas dock control exposes its open state and opens a panel with quick entry above the selected project's list.": async ({ page, origin }) => {
    await open(page, origin);
    const dock = page.getByRole("button", { name: "Ý tưởng", exact: true });
    assert.equal(await dock.getAttribute("aria-pressed"), "false");
    const panel = await show(page);
    assert.equal(await dock.getAttribute("aria-pressed"), "true");
    assert.equal(await dock.getAttribute("aria-expanded"), "true");
    await panel.getByText("Chưa có ý tưởng.", { exact: true }).waitFor();
    assert.match(await panel.innerText(), /PROJECT-A/);
    const input = await panel.getByLabel("Ý tưởng mới", { exact: true }).boundingBox();
    const list = await panel.getByRole("list", { name: "Danh sách ý tưởng" }).boundingBox();
    assert.ok(input.y + input.height <= list.y);
    await panel.getByRole("button", { name: "Đóng Ý tưởng" }).click();
    assert.equal(await dock.getAttribute("aria-pressed"), "false");
    assert.equal(await panel.isVisible(), false);
  },
  "A user can create, edit, complete, reopen, cancel deletion, and confirm deletion without sending a conversation message, including when no agent is selected or the selected agent is busy.": async ({ page, origin }) => {
    for (const mode of ["?noAgent=1", ""]) {
      await open(page, origin, mode);
      if (!mode) { await chunk(page, "Busy agent"); await page.getByRole("status", { name: "Waiting for agent response" }).waitFor(); }
      const panel = await show(page);
      await create(page, "Captured idea");
      if (mode) {
        assert.equal(await page.evaluate(() => window.fixtureNoAgent), true);
        assert.equal(await page.locator(".claude-architecture-list [role=option]").count(), 0);
      }
      const row = panel.locator("li");
      await row.getByRole("button", { name: "Sửa", exact: true }).click();
      await row.getByLabel("Sửa nội dung").fill("Revised idea");
      await row.getByRole("button", { name: "Lưu nội dung" }).click();
      await row.getByText("Revised idea", { exact: true }).waitFor();
      await row.getByRole("button", { name: "Hoàn thành" }).click();
      await row.getByText("Đã xong", { exact: true }).waitFor();
      await row.getByRole("button", { name: "Mở lại" }).click();
      await row.getByText("Đang mở", { exact: true }).waitFor();
      await row.getByRole("button", { name: "Xóa", exact: true }).click();
      await row.getByRole("button", { name: "Hủy xóa" }).click();
      assert.equal(await row.count(), 1);
      assert.equal(await page.evaluate(() => window.calls.filter(c => c.method === "DELETE").length), 0);
      await page.reload();
      await page.getByRole("button", { name: "Ý tưởng", exact: true }).waitFor();
      await show(page);
      await panel.getByText("Revised idea", { exact: true }).waitFor();
      await row.getByRole("button", { name: "Xóa", exact: true }).click();
      await row.getByRole("button", { name: "Xác nhận xóa", exact: true }).click();
      await panel.getByText("Chưa có ý tưởng.", { exact: true }).waitFor();
      assert.equal(await row.count(), 0);
      await assertOnlyIdeasWrites(page);
      await page.reload(); await page.getByRole("button", { name: "Ý tưởng", exact: true }).waitFor(); await show(page);
      await panel.getByText("Chưa có ý tưởng.", { exact: true }).waitFor();
    }
  },
  "Loading, empty, saving, error, and retry states are observable, and Saved appears only after a successful backend response.": async ({ page, origin }) => {
    await open(page, origin);
    await page.evaluate(() => { window.control.holdList = true; });
    const panel = await show(page);
    await panel.getByText("Đang tải…", { exact: true }).waitFor();
    await page.evaluate(() => window.releaseList());
    await panel.getByText("Chưa có ý tưởng.", { exact: true }).waitFor();
    await page.evaluate(() => { window.control.holdMutation = true; });
    await panel.getByLabel("Ý tưởng mới", { exact: true }).fill("Delayed idea");
    await panel.getByRole("button", { name: "Thêm ý tưởng" }).click();
    await panel.getByText("Đang lưu…", { exact: true }).waitFor();
    assert.equal(await panel.getByText("Đã lưu", { exact: true }).count(), 0);
    assert.equal(await panel.locator("li").count(), 0);
    await page.evaluate(() => window.releaseMutation());
    await panel.getByText("Đã lưu", { exact: true }).waitFor();
    await page.evaluate(() => { window.control.failMutation = true; window.control.failList = true; });
    await panel.getByLabel("Ý tưởng mới", { exact: true }).fill("Retained after failure");
    await panel.getByRole("button", { name: "Thêm ý tưởng" }).click();
    await panel.getByRole("alert").waitFor();
    assert.equal(await panel.getByText("Đã lưu", { exact: true }).count(), 0);
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).inputValue(), "Retained after failure");
    await panel.getByRole("button", { name: "Thử lại" }).click();
    await panel.getByText(/Ideas unavailable/).waitFor();
    await page.evaluate(() => { window.control.failList = false; window.control.failMutation = false; });
    await panel.getByRole("button", { name: "Thử lại" }).click();
    await panel.getByRole("alert").waitFor({ state: "hidden" });
    await create(page, "Recovered idea");
    // Deliver a captured pre-create response after POST succeeds, then verify reconciliation.
    await open(page, origin);
    await page.evaluate(() => {
      const fetch = window.fetch;
      let held = false;
      window.fetch = async (url, init) => {
        const response = await fetch(url, init);
        if (!held && !init?.method && String(url).includes("/ideas")) {
          held = true;
          await new Promise(resolve => { window.releaseSnapshot = resolve; });
        }
        return response;
      };
    });
    await show(page);
    await panel.getByText("Đang tải…", { exact: true }).waitFor();
    await panel.getByLabel("Ý tưởng mới", { exact: true }).fill("Created before list");
    await panel.getByRole("button", { name: "Thêm ý tưởng", exact: true }).click();
    await panel.locator("li").filter({ hasText: "Created before list" }).waitFor();
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).inputValue(), "");
    await page.evaluate(() => window.releaseSnapshot());
    await panel.getByText("Đang tải…", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await panel.locator("li").count(), 1);
    assert.equal(await panel.locator("li").filter({ hasText: "Created before list" }).count(), 1);
    await assertOnlyIdeasWrites(page);
  },
  "Unsubmitted content survives closing and reopening the panel and changing conversation or agent.": async ({ page, viewport, origin }) => {
    await open(page, origin); const panel = await show(page);
    await create(page, "Original idea");
    await panel.locator("li").getByRole("button", { name: "Sửa", exact: true }).click();
    await panel.getByLabel("Sửa nội dung").fill("Unsubmitted edit");
    await panel.getByLabel("Ý tưởng mới", { exact: true }).fill("Unsubmitted quick entry");
    await panel.getByRole("button", { name: "Đóng Ý tưởng" }).click();
    await navigation(page, viewport);
    await page.getByRole("button", { name: "Second conversation", exact: true }).click();
    await page.getByRole("heading", { name: "Second conversation", exact: true }).waitFor();
    await page.locator(".claude-sidebar-architecture > summary").click();
    const agent = page.getByRole("option", { name: /Second agent/ });
    await agent.click();
    assert.equal(await agent.getAttribute("aria-selected"), "true");
    if (viewport < 640) await page.keyboard.press("Escape");
    await show(page);
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).inputValue(), "Unsubmitted quick entry");
    assert.equal(await panel.getByLabel("Sửa nội dung").inputValue(), "Unsubmitted edit");
  },
  "Opening, closing, and using Ideas preserves the mounted conversation, its SSE connection, and all streamed content.": async ({ page, origin }) => {
    await open(page, origin); await chunk(page, "Beginning ");
    const log = page.getByRole("log"); await log.getByText("Beginning", { exact: false }).waitFor();
    const identity = await log.elementHandle();
    const transport = await page.evaluate(() => ({ opened: window.sources.length, closed: window.streamCloseCount }));
    const panel = await show(page); await chunk(page, "middle ");
    await create(page, "Idea during streaming");
    await panel.getByRole("button", { name: "Đóng Ý tưởng" }).click();
    await chunk(page, "ending");
    await log.getByText("Beginning middle ending", { exact: false }).waitFor();
    assert.equal(await identity.evaluate(element => element === document.querySelector('[role="log"]')), true);
    assert.deepEqual(await page.evaluate(() => ({ opened: window.sources.length, closed: window.streamCloseCount })), transport);
    assert.ok(transport.opened > 0);
    assert.equal(await log.locator(".claude-message.is-agent").count(), 1);
    await assertOnlyIdeasWrites(page);
  },
  "Keyboard users can operate labelled controls and the panel remains within the viewport without horizontal page overflow.": async ({ page, viewport, origin }) => {
    await open(page, origin);
    const dock = page.getByRole("button", { name: "Ý tưởng", exact: true });
    await tabTo(page, dock); await page.keyboard.press("Enter");
    const panel = page.getByRole("region", { name: "Ý tưởng", exact: true });
    const input = panel.getByLabel("Ý tưởng mới", { exact: true });
    assert.equal(await input.evaluate(element => element === document.activeElement), true);
    await page.keyboard.type("Keyboard idea");
    await page.keyboard.press("Tab"); await page.keyboard.press("Enter");
    await panel.getByText("Đã lưu", { exact: true }).waitFor();
    await tabTo(page, panel.getByRole("button", { name: "Hoàn thành" })); await page.keyboard.press("Enter");
    await panel.getByRole("button", { name: "Mở lại" }).waitFor();
    await tabTo(page, panel.getByRole("button", { name: "Xóa", exact: true })); await page.keyboard.press("Enter");
    await tabTo(page, panel.getByRole("button", { name: "Hủy xóa" })); await page.keyboard.press("Enter");
    const bounds = await panel.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport);
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= await page.evaluate(() => innerHeight));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.keyboard.press("Escape");
    assert.equal(await dock.evaluate(element => element === document.activeElement), true);
    assert.equal(await dock.getAttribute("aria-pressed"), "false");
  }
};
