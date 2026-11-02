/**
 * Browser verification scenario for quiet initial Notebook loading, retry button removal, compact
 * quick-entry submit layout, versioned CRUD, 409 conflict handling, and draft/uncertainty safety.
 * Exercises the real bundled Next.js workspace and Notebook components in Chromium across 375, 768,
 * and 1440 pixel viewports to verify DOM state, CSS layout, and HTTP request invariants.
 */
import assert from "node:assert/strict";
export { createBrowserFixture } from "./notebook-loading-entry-fixture.mjs";

/**
 * Opens the Notebook floating panel from the workspace monitor dock and waits for it to be visible.
 */
async function openNotebookPanel(page) {
  const dockBtn = page.locator(".workspace-monitor-dock").getByRole("button", { name: "Sổ tay", exact: true });
  await dockBtn.waitFor();
  if ((await dockBtn.getAttribute("aria-pressed")) !== "true") {
    await dockBtn.click();
  }
  const panel = page.getByRole("region", { name: "Sổ tay", exact: true });
  await panel.waitFor();
  return { dockBtn, panel };
}

/**
 * Maps every approved acceptance assertion string to an executable Playwright verification function.
 */
export const browserAssertions = {
  "Opening Notebook with no repository, an initial 503 permission-port response, or another unavailable initial list shows normal empty state without the unconfirmed-save load warning or retry button.": async ({ page, origin }) => {
    await page.goto(origin);
    for (const [index, listMode] of ["no-repo", "503-port", "network-error"].entries()) {
      const projectId = `PROJECT-INIT-${index}-${listMode}`;
      await page.evaluate((cfg) => window.switchScenario(cfg), {
        projectId,
        listMode,
        records: [],
      });
      const { panel } = await openNotebookPanel(page);
      await panel.getByText("Chưa có sổ tay.", { exact: true }).waitFor();
      assert.equal(await panel.getByRole("alert").count(), 0);
      assert.equal(await panel.getByRole("note").count(), 0);
      assert.doesNotMatch(await panel.innerText(), /Chưa xác nhận lưu\. Không thể tải dữ liệu/);
      assert.equal(await panel.getByRole("button", { name: "Thử lại" }).count(), 0);
    }
  },

  "NotebookPanel error states contain no retry button while mutation conflict and uncertain-save feedback remain observable.": async ({ page, origin }) => {
    await page.goto(origin);
    await page.evaluate((cfg) => window.switchScenario(cfg), {
      projectId: "PROJECT-ERRORS",
      listMode: "ok",
      mutationMode: "fail-503",
      records: [{ id: "err-1", project_id: "PROJECT-ERRORS", content: "Existing item", status: "open", version: 1 }],
    });
    const { panel } = await openNotebookPanel(page);
    await panel.getByText("Existing item", { exact: true }).waitFor();

    await panel.getByLabel("Sổ tay mới", { exact: true }).fill("Uncertain entry");
    await panel.getByRole("button", { name: "Thêm sổ tay", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "Chưa xác nhận lưu" }).waitFor();
    await panel.getByRole("note").filter({ hasText: "Chưa xác nhận lưu" }).waitFor();
    assert.equal(await panel.getByRole("button", { name: "Thử lại" }).count(), 0);

    await page.evaluate(() => {
      window.control.mutationMode = "ok";
      window.records[0].version = 5;
      window.records[0].content = "Remote v5";
    });
    await panel.locator('[data-notebook-id="err-1"]').getByRole("button", { name: "Sửa", exact: true }).click();
    await panel.getByLabel("Sửa nội dung", { exact: true }).fill("Conflicting local edit");
    await panel.getByRole("button", { name: "Lưu nội dung", exact: true }).click();
    await panel.getByRole("note").filter({ hasText: "Đã tải dữ liệu để đối chiếu" }).waitFor();
    await panel.getByRole("button", { name: "Lưu nội dung", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "Xung đột phiên bản" }).waitFor();
    assert.equal(await panel.getByRole("button", { name: "Thử lại" }).count(), 0);
    await panel.getByRole("button", { name: "Tải bản server để đối chiếu", exact: true }).waitFor();
  },

  "The quick-entry submit button is below the textarea, right aligned, uses align-self flex-end and width fit-content, and is visibly narrower than the form at each approved viewport.": async ({ page, origin }) => {
    await page.goto(origin);
    await page.evaluate((cfg) => window.switchScenario(cfg), {
      projectId: "PROJECT-LAYOUT",
      listMode: "ok",
      records: [],
    });
    const { panel } = await openNotebookPanel(page);
    const textarea = panel.getByLabel("Sổ tay mới", { exact: true });
    const submitBtn = panel.getByRole("button", { name: "Thêm sổ tay", exact: true });
    await textarea.waitFor();
    await submitBtn.waitFor();

    const metrics = await submitBtn.evaluate((btn) => {
      const form = btn.closest("form");
      const textareaEl = form.querySelector("textarea");
      const computed = window.getComputedStyle(btn);
      const styleRules = [];
      for (const sheet of Array.from(document.styleSheets)) {
        for (const rule of Array.from(sheet.cssRules || [])) {
          if (rule.selectorText && btn.matches(rule.selectorText)) {
            styleRules.push({ alignSelf: rule.style.alignSelf, width: rule.style.width });
          }
        }
      }
      const btnRect = btn.getBoundingClientRect();
      const formRect = form.getBoundingClientRect();
      const textareaRect = textareaEl.getBoundingClientRect();
      return {
        computedAlignSelf: computed.alignSelf,
        styleRules,
        btnRect: { x: btnRect.x, y: btnRect.y, width: btnRect.width, right: btnRect.right },
        formRect: { x: formRect.x, y: formRect.y, width: formRect.width, right: formRect.right },
        textareaRect: { bottom: textareaRect.bottom },
      };
    });

    assert.equal(metrics.computedAlignSelf, "flex-end");
    assert.ok(metrics.styleRules.some((r) => r.alignSelf === "flex-end" && r.width === "fit-content"));
    assert.ok(metrics.btnRect.y >= metrics.textareaRect.bottom - 1);
    assert.ok(metrics.btnRect.width < metrics.formRect.width * 0.85);
    assert.ok(Math.abs(metrics.formRect.right - metrics.btnRect.right) <= 2);
  },

  "With an available repository, users can create, edit, complete, reopen, and delete Notebook items through the real panel, and a 409 retains the local edit and original version while allowing server comparison.": async ({ page, origin }) => {
    await page.goto(origin);
    await page.evaluate((cfg) => window.switchScenario(cfg), {
      projectId: "PROJECT-CRUD",
      listMode: "ok",
      mutationMode: "ok",
      records: [],
    });
    const { panel } = await openNotebookPanel(page);
    await panel.getByText("Chưa có sổ tay.", { exact: true }).waitFor();

    await panel.getByLabel("Sổ tay mới", { exact: true }).fill("First notebook entry");
    await panel.getByRole("button", { name: "Thêm sổ tay", exact: true }).click();
    await panel.getByText("Đã lưu", { exact: true }).waitFor();
    const row = panel.locator("li").filter({ hasText: "First notebook entry" });
    await row.waitFor();

    await row.getByRole("button", { name: "Sửa", exact: true }).click();
    await panel.getByLabel("Sửa nội dung", { exact: true }).fill("Edited notebook entry");
    await panel.getByRole("button", { name: "Lưu nội dung", exact: true }).click();
    await panel.locator("li").filter({ hasText: "Edited notebook entry" }).waitFor();

    const updatedRow = panel.locator("li");
    const todoStyles = await updatedRow.evaluate((li) => {
      const contentEl = li.querySelector(".notebook-todo-content");
      const editBtn = li.querySelector('button[aria-label="Sửa"]');
      const delBtn = li.querySelector('button[aria-label="Xóa"]');
      const contentRect = contentEl.getBoundingClientRect();
      const editRect = editBtn.getBoundingClientRect();
      return {
        fontSize: window.getComputedStyle(contentEl).fontSize,
        textDecoration: window.getComputedStyle(contentEl).textDecorationLine,
        editRightOfContent: editRect.left >= contentRect.right - 2,
        editWidth: Math.round(editRect.width),
        delWidth: Math.round(delBtn.getBoundingClientRect().width)
      };
    });
    assert.equal(todoStyles.fontSize, "12px");
    assert.equal(todoStyles.editRightOfContent, true);
    assert.ok(todoStyles.editWidth <= 28 && todoStyles.delWidth <= 28);

    await updatedRow.getByRole("checkbox", { name: "Hoàn thành", exact: true }).click();
    const doneRow = panel.getByRole("list", { name: "Danh sách sổ tay đã hoàn thành", exact: true }).locator("li").filter({ hasText: "Edited notebook entry" });
    await doneRow.waitFor();
    const doneDecoration = await doneRow.locator(".notebook-todo-content").evaluate((el) => window.getComputedStyle(el).textDecorationLine);
    assert.match(doneDecoration, /line-through/);

    await updatedRow.getByRole("checkbox", { name: "Mở lại", exact: true }).click();
    await panel.getByRole("list", { name: "Danh sách sổ tay", exact: true }).locator("li").filter({ hasText: "Edited notebook entry" }).waitFor();

    await updatedRow.getByRole("button", { name: "Sửa", exact: true }).click();
    await panel.getByLabel("Sửa nội dung", { exact: true }).fill("Local conflicting draft");
    await panel.getByText("Phiên bản gốc: 4", { exact: true }).waitFor();

    await page.evaluate(() => {
      window.records[0].version = 9;
      window.records[0].content = "Server version 9 content";
    });
    await panel.getByRole("button", { name: "Lưu nội dung", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "Xung đột phiên bản" }).waitFor();
    assert.equal(await panel.getByLabel("Sửa nội dung", { exact: true }).inputValue(), "Local conflicting draft");
    await panel.getByText("Phiên bản gốc: 4", { exact: true }).waitFor();

    await panel.getByRole("button", { name: "Tải bản server để đối chiếu", exact: true }).click();
    await panel.getByRole("complementary", { name: "Bản server" }).getByText("Server version 9 content", { exact: true }).waitFor();
    assert.equal(await panel.getByLabel("Sửa nội dung", { exact: true }).inputValue(), "Local conflicting draft");

    await panel.getByRole("button", { name: "Hủy sửa", exact: true }).click();
    await page.evaluate(() => {
      window.records[0].version = 4;
      window.records[0].content = "Edited notebook entry";
    });

    await panel.getByLabel("Sổ tay mới", { exact: true }).fill("Second notebook entry");
    await panel.getByRole("button", { name: "Thêm sổ tay", exact: true }).click();
    const secondRow = panel.locator("li").filter({ hasText: "Second notebook entry" });
    await secondRow.waitFor();
    await secondRow.dragTo(updatedRow);
    await panel.getByText("Đã lưu", { exact: true }).waitFor();
    const openTexts = await panel.getByRole("list", { name: "Danh sách sổ tay", exact: true }).locator("li .notebook-todo-content").allInnerTexts();
    assert.deepEqual(openTexts, ["Second notebook entry", "Edited notebook entry"]);

    await secondRow.getByRole("button", { name: "Xóa", exact: true }).click();
    await secondRow.getByRole("button", { name: "Xác nhận xóa", exact: true }).click();
    await secondRow.waitFor({ state: "detached" });

    await updatedRow.getByRole("button", { name: "Xóa", exact: true }).click();
    await updatedRow.getByRole("button", { name: "Xác nhận xóa", exact: true }).click();
    await panel.getByText("Chưa có sổ tay.", { exact: true }).waitFor();
  },

  "Initial-list failure and subsequent panel controls preserve typed drafts, and uncertain mutation outcomes do not trigger automatic repeated writes or false saved confirmation.": async ({ page, origin }) => {
    await page.goto(origin);
    await page.evaluate((cfg) => window.switchScenario(cfg), {
      projectId: "PROJECT-SAFETY",
      listMode: "503-port",
      mutationMode: "lost-after-commit",
      records: [],
      draft: {
        content: "Pre-existing quick draft",
        edit: { id: "draft-edit-1", project_id: "PROJECT-SAFETY", content: "Pre-existing edit draft", version: 2, status: "open" },
      },
    });
    const { dockBtn, panel } = await openNotebookPanel(page);
    assert.equal(await panel.getByLabel("Sổ tay mới", { exact: true }).inputValue(), "Pre-existing quick draft");
    assert.equal(await panel.getByLabel("Sửa nội dung", { exact: true }).inputValue(), "Pre-existing edit draft");
    assert.equal(await panel.getByRole("alert").count(), 0);

    const minBtn = panel.locator(".workspace-monitor-header").getByRole("button", { name: /Thu gọn Sổ tay|Mở rộng Sổ tay/ });
    await minBtn.click();
    await minBtn.click();
    await panel.locator(".workspace-monitor-header").getByRole("button", { name: "Đóng Sổ tay", exact: true }).click();
    await dockBtn.click();
    assert.equal(await panel.getByLabel("Sổ tay mới", { exact: true }).inputValue(), "Pre-existing quick draft");
    assert.equal(await panel.getByLabel("Sửa nội dung", { exact: true }).inputValue(), "Pre-existing edit draft");

    await page.evaluate(() => { window.control.listMode = "ok"; });
    await panel.getByRole("button", { name: "Thêm sổ tay", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: "Chưa xác nhận lưu" }).waitFor();
    await panel.getByRole("note").filter({ hasText: "Gửi lại có thể tạo bản trùng" }).waitFor();
    assert.equal(await panel.getByText("Đã lưu", { exact: true }).count(), 0);
    assert.equal(await panel.getByLabel("Sổ tay mới", { exact: true }).inputValue(), "Pre-existing quick draft");

    let postCount = await page.evaluate(() => window.calls.filter((c) => c.method === "POST").length);
    assert.equal(postCount, 1);

    await page.evaluate(() => { window.control.mutationMode = "ok"; });
    await panel.getByRole("button", { name: "Thêm sổ tay", exact: true }).click();
    await panel.getByRole("note").filter({ hasText: "Đã tải dữ liệu để đối chiếu" }).waitFor();
    postCount = await page.evaluate(() => window.calls.filter((c) => c.method === "POST").length);
    assert.equal(postCount, 1);
    assert.equal(await panel.getByText("Đã lưu", { exact: true }).count(), 0);
    assert.equal(await panel.getByLabel("Sổ tay mới", { exact: true }).inputValue(), "Pre-existing quick draft");
  },
};
