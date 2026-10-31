/**
 * Business purpose: Supplies browser verification scenarios for O4 Ideas mutation failure
 * classification, conflict comparison, reconciliation retry safety, and runtime-authorized CRUD
 * privacy within the floating Ideas monitor.
 * Technical description: Exports shared reset and monitor-opening helpers plus the six O4
 * browserAssertions functions exercising definite non-409 HTTP failures, statusless network
 * failures, 409 conflicts, reconnection safety, and full CRUD storage isolation in Chromium.
 */
import assert from "node:assert/strict";

export const LAYOUT_KEY = "nodeforge:workspace-monitor-layout:home";

/**
 * Business purpose: Resets browser storage and reloads the Architecture Manager workspace so
 * each browser assertion starts from a deterministic state.
 * Technical description: Navigates to origin, clears localStorage and sessionStorage, optionally
 * seeds initial monitor layout state, reloads the page, and waits for the dock and conversation heading.
 */
export async function resetWorkspace(page, origin, initialLayout = null) {
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
 * Business purpose: Opens the Ideas floating monitor from the workspace dock when hidden or
 * minimized so assertions can interact with the notebook body.
 * Technical description: Locates the dock button, clicks it if aria-pressed is not true, and
 * waits for the Ideas region element to become visible in the DOM.
 */
export async function openIdeasMonitor(page) {
  const dockBtn = page.locator(".workspace-monitor-dock").getByRole("button", { name: "Ý tưởng", exact: true });
  await dockBtn.waitFor();
  if ((await dockBtn.getAttribute("aria-pressed")) !== "true") await dockBtn.click();
  const panel = page.getByRole("region", { name: "Ý tưởng", exact: true });
  await panel.waitFor();
  return { dockBtn, panel };
}

/**
 * Business purpose: Opens the conversation navigation drawer on narrow mobile viewports and
 * dismisses overlapping monitors so conversation switching assertions can click sidebar items.
 * Technical description: Closes Watcher and Agent monitor windows if visible and triggers the
 * mobile conversation sidebar button when viewport width is under 640px.
 */
export async function openNavigationDrawerIfNeeded(page, viewport) {
  for (const name of ["Close Watcher monitor", "Close Agent monitor"]) {
    const closeBtn = page.getByRole("button", { name, exact: true });
    if (await closeBtn.isVisible()) await closeBtn.click();
  }
  if (viewport < 640) {
    await page.locator('.conversation-mobile-rail button[aria-label="Open conversations sidebar"]').evaluate((btn) => btn.click());
  }
}

export const o4BrowserAssertions = {
  "A definite non-409 HTTP failure during each Ideas mutation displays an error without a new duplicate-risk warning and preserves the relevant draft.": async ({ page, origin }) => {
    await resetWorkspace(page, origin);
    const { panel } = await openIdeasMonitor(page);
    await panel.getByText("Existing project idea", { exact: true }).waitFor();

    await panel.getByLabel("Ý tưởng mới", { exact: true }).fill("Create draft kept on 503");
    await page.evaluate(() => { window.nextIdeasFailure = { method: "POST", status: 503, message: "Create HTTP 503 error" }; });
    await panel.getByRole("button", { name: "Thêm ý tưởng", exact: true }).click();
    await panel.getByRole("alert").waitFor();
    assert.match(await panel.getByRole("alert").innerText(), /Create HTTP 503 error/);
    assert.equal(await panel.getByRole("note").count(), 0);
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).inputValue(), "Create draft kept on 503");

    const row = panel.locator('[data-idea-id="idea-1"]');
    await row.getByRole("button", { name: "Hoàn thành", exact: true }).click();
    await row.getByRole("button", { name: "Mở lại", exact: true }).waitFor();
    await page.evaluate(() => { window.nextIdeasFailure = { method: "PATCH", status: 500, message: "Toggle HTTP 500 error" }; });
    await row.getByRole("button", { name: "Mở lại", exact: true }).click();
    await panel.getByRole("alert").waitFor();
    assert.match(await panel.getByRole("alert").innerText(), /Toggle HTTP 500 error/);
    assert.equal(await panel.getByRole("note").count(), 0);
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).inputValue(), "Create draft kept on 503");

    await row.getByRole("button", { name: "Xóa", exact: true }).click();
    await page.evaluate(() => { window.nextIdeasFailure = { method: "DELETE", status: 503, message: "Delete HTTP 503 error" }; });
    await row.getByRole("group", { name: "Xác nhận xóa" }).getByRole("button", { name: "Xác nhận xóa", exact: true }).click();
    await panel.getByRole("alert").waitFor();
    assert.match(await panel.getByRole("alert").innerText(), /Delete HTTP 503 error/);
    assert.equal(await panel.getByRole("note").count(), 0);
    await row.getByRole("button", { name: "Hủy xóa", exact: true }).click();

    await row.getByRole("button", { name: "Sửa", exact: true }).click();
    await panel.getByLabel("Sửa nội dung", { exact: true }).fill("Edit draft kept on 502");
    await page.evaluate(() => { window.nextIdeasFailure = { method: "PATCH", status: 502, message: "Edit HTTP 502 error" }; });
    await row.getByRole("button", { name: "Lưu nội dung", exact: true }).click();
    await panel.getByRole("alert").waitFor();
    assert.match(await panel.getByRole("alert").innerText(), /Edit HTTP 502 error/);
    assert.equal(await panel.getByRole("note").count(), 0);
    assert.equal(await panel.getByLabel("Sửa nội dung", { exact: true }).inputValue(), "Edit draft kept on 502");
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).inputValue(), "Create draft kept on 503");
  },

  "After a definite HTTP failure, the next explicit retry does not require a reconciliation GET.": async ({ page, origin }) => {
    await resetWorkspace(page, origin);
    const { panel } = await openIdeasMonitor(page);
    await panel.getByText("Existing project idea", { exact: true }).waitFor();

    await panel.getByLabel("Ý tưởng mới", { exact: true }).fill("Retry directly after 503");
    await page.evaluate(() => {
      window.calls = [];
      window.nextIdeasFailure = { method: "POST", status: 503, message: "Temporary 503 error" };
    });
    await panel.getByRole("button", { name: "Thêm ý tưởng", exact: true }).click();
    await panel.getByRole("alert").waitFor();
    assert.equal(await panel.getByRole("note").count(), 0);

    await panel.getByRole("button", { name: "Thêm ý tưởng", exact: true }).click();
    await panel.getByRole("list", { name: "Danh sách ý tưởng", exact: true }).getByText("Retry directly after 503", { exact: true }).waitFor();
    const methods = await page.evaluate(() => window.calls.filter((c) => c.path.includes("/ideas")).map((c) => c.method));
    assert.deepEqual(methods, ["POST", "POST"]);
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).inputValue(), "");
  },

  "A mutation failure without HTTP status displays uncertainty, retains the draft, and requires reconciliation before another explicit write.": async ({ page, origin }) => {
    await resetWorkspace(page, origin);
    const { panel } = await openIdeasMonitor(page);
    await panel.getByText("Existing project idea", { exact: true }).waitFor();

    await panel.getByLabel("Ý tưởng mới", { exact: true }).fill("Uncertain network create");
    await page.evaluate(() => {
      window.calls = [];
      window.nextIdeasFailure = { method: "POST", type: "network", message: "Socket hang up" };
    });
    await panel.getByRole("button", { name: "Thêm ý tưởng", exact: true }).click();
    await panel.getByRole("note").waitFor();
    assert.match(await panel.getByRole("note").innerText(), /Chưa xác nhận lưu.*Gửi lại có thể tạo bản trùng/);
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).inputValue(), "Uncertain network create");

    await panel.getByRole("button", { name: "Thêm ý tưởng", exact: true }).click();
    await panel.getByText(/Đã tải dữ liệu để đối chiếu/).waitFor();
    const methodsAfterReconcile = await page.evaluate(() => window.calls.filter((c) => c.path.includes("/ideas")).map((c) => c.method));
    assert.deepEqual(methodsAfterReconcile, ["POST", "GET"]);
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).inputValue(), "Uncertain network create");
  },

  "Reconciliation and reconnection never automatically replay an Ideas write.": async ({ page, origin }) => {
    await resetWorkspace(page, origin);
    const { panel } = await openIdeasMonitor(page);
    await panel.getByText("Existing project idea", { exact: true }).waitFor();

    await panel.getByLabel("Ý tưởng mới", { exact: true }).fill("Never auto-replayed");
    await page.evaluate(() => {
      window.calls = [];
      window.nextIdeasFailure = { method: "POST", type: "network", message: "Lost connection" };
    });
    await panel.getByRole("button", { name: "Thêm ý tưởng", exact: true }).click();
    await panel.getByRole("note").waitFor();

    await panel.getByRole("button", { name: "Thêm ý tưởng", exact: true }).click();
    await panel.getByText(/Đã tải dữ liệu để đối chiếu/).waitFor();

    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      for (const source of window.sources || []) {
        source.onopen?.(new Event("open"));
        source.dispatchEvent(new Event("open"));
      }
    });
    const postCalls = await page.evaluate(() => window.calls.filter((c) => c.path.includes("/ideas") && c.method === "POST").length);
    assert.equal(postCalls, 1);
    assert.equal(await panel.getByLabel("Ý tưởng mới", { exact: true }).inputValue(), "Never auto-replayed");
  },

  "A 409 edit or delete conflict preserves the local draft and supports comparison with the server record.": async ({ page, origin }) => {
    await resetWorkspace(page, origin);
    const { panel } = await openIdeasMonitor(page);
    await panel.getByText("Existing project idea", { exact: true }).waitFor();

    const row = panel.locator('[data-idea-id="idea-1"]');
    await row.getByRole("button", { name: "Sửa", exact: true }).click();
    await panel.getByLabel("Sửa nội dung", { exact: true }).fill("Local conflicting edit");
    await page.evaluate(() => {
      window.records[0].content = "Updated on server v3";
      window.records[0].version = 3;
    });
    await row.getByRole("button", { name: "Lưu nội dung", exact: true }).click();
    await panel.getByRole("alert").waitFor();
    assert.match(await panel.getByRole("alert").innerText(), /Xung đột phiên bản/);
    assert.equal(await panel.getByLabel("Sửa nội dung", { exact: true }).inputValue(), "Local conflicting edit");
    await panel.getByRole("button", { name: "Tải bản server để đối chiếu", exact: true }).click();
    const comparison = panel.getByRole("complementary", { name: "Bản server", exact: true });
    await comparison.waitFor();
    assert.match(await comparison.innerText(), /Updated on server v3/);
    assert.match(await comparison.innerText(), /Version:\s*3/);

    await row.getByRole("button", { name: "Hủy sửa", exact: true }).click();
    await row.getByRole("button", { name: "Xóa", exact: true }).click();
    await row.getByRole("group", { name: "Xác nhận xóa" }).getByRole("button", { name: "Xác nhận xóa", exact: true }).click();
    await panel.getByRole("alert").waitFor();
    assert.match(await panel.getByRole("alert").innerText(), /Xung đột phiên bản/);
    await panel.getByRole("button", { name: "Tải bản server để đối chiếu", exact: true }).click();
    await comparison.waitFor();
    assert.match(await comparison.innerText(), /Updated on server v3/);
  },

  "The browser scenario exercises the runtime-authorized Ideas operations without exposing content to browser storage.": async ({ page, origin }) => {
    const quickSecret = "RUNTIME_AUTH_QUICK_77123";
    const editSecret = "RUNTIME_AUTH_EDIT_77124";
    await resetWorkspace(page, origin);
    const { panel } = await openIdeasMonitor(page);
    await panel.getByText("Existing project idea", { exact: true }).waitFor();

    await panel.getByLabel("Ý tưởng mới", { exact: true }).fill(quickSecret);
    await panel.getByRole("button", { name: "Thêm ý tưởng", exact: true }).click();
    const row = panel.locator('[data-idea-id="idea-2"]');
    await row.getByText(quickSecret, { exact: true }).waitFor();

    await row.getByRole("button", { name: "Sửa", exact: true }).click();
    await panel.getByLabel("Sửa nội dung", { exact: true }).fill(editSecret);
    await row.getByRole("button", { name: "Lưu nội dung", exact: true }).click();
    await row.locator("p", { hasText: editSecret }).waitFor();

    await row.getByRole("button", { name: "Hoàn thành", exact: true }).click();
    await row.getByText("Đã xong", { exact: true }).waitFor();

    await row.getByRole("button", { name: "Xóa", exact: true }).click();
    await row.getByRole("group", { name: "Xác nhận xóa" }).getByRole("button", { name: "Xác nhận xóa", exact: true }).click();
    await row.waitFor({ state: "detached" });
    assert.equal(await panel.locator('[data-idea-id="idea-2"]').count(), 0);

    const privacy = await page.evaluate(({ q, e }) => {
      const dump = JSON.stringify([window.localStorage, window.sessionStorage, window.storageWrites, window.consoleLogs]);
      return !dump.includes(q) && !dump.includes(e);
    }, { q: quickSecret, e: editSecret });
    assert.equal(privacy, true);
  }
};
