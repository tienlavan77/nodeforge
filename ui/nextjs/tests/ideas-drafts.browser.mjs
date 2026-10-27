/**
 * Proves the approved draft safety contract through real rendered project workspaces.
 * Each assertion starts from a fresh document and controls only external HTTP timing.
 * Checks inspect editable text, project lists, original request versions and transport
 * counts so server comparison and retry feedback cannot silently overwrite user input.
 */
import assert from "node:assert/strict";
export { createBrowserFixture } from "./ideas-drafts-fixture.mjs";

/** Open the actual dock after admission and wait for its accessible notebook controls. */
async function openPanel(page) {
  const trigger = page.getByRole("button", { name: "Ý tưởng", exact: true });
  await trigger.waitFor();
  if (await trigger.getAttribute("aria-pressed") !== "true") await trigger.click();
  await page.getByLabel("Ý tưởng mới", { exact: true }).waitFor();
}
/** Start each approved browser scenario with independent server records and UI session state. */
async function start(page, origin) { await page.goto(origin); await openPanel(page); }
/** Read the current project list after its asynchronous admission and collection load complete. */
async function listReady(page, text) {
  await page.getByRole("list", { name: "Danh sách ý tưởng" }).getByText(text, { exact: true }).waitFor();
}
/** Verify a form value without depending on JSX attribute order or stylesheet implementation. */
async function value(page, label, expected) {
  assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), expected);
}
/** Switch actual workspace props and wait until the new admitted project panel is usable. */
async function choose(page, project) {
  await page.evaluate(id => window.choose(id), project);
  await page.waitForFunction(id => document.querySelector(".ideas-project")?.textContent === "Project: " + id, project);
  await openPanel(page);
  await page.getByText("Project: " + project, { exact: true }).waitFor();
}
/** Count only mutation calls, excluding authoritative reads and workspace admission requests. */
async function mutations(page) {
  return page.evaluate(() => window.calls.filter(call => ["POST", "PATCH", "DELETE"].includes(call.method)));
}
/** Begin a real edit and preserve the selected record's original version through input changes. */
async function edit(page, content) {
  await listReady(page, "Server A");
  await page.locator('[data-idea-id="a1"]').getByRole("button", { name: "Sửa", exact: true }).click();
  await page.getByLabel("Sửa nội dung", { exact: true }).fill(content);
}
/** Wait for an uncertain outcome without assuming the panel remains mounted after admission loss. */
async function unconfirmed(page) {
  await page.locator('[role="alert"],[role="note"]').filter({ hasText: "Chưa xác nhận lưu" }).first().waitFor();
}

export const browserAssertions = {
  "New and edited drafts retain project identity, idea identity, and original version across panel closure and workspace remounts.": async ({ page, origin }) => {
    await start(page, origin); await edit(page, "unfinished edit");
    await page.getByLabel("Ý tưởng mới", { exact: true }).fill("unfinished quick");
    await page.getByRole("button", { name: "Đóng Ý tưởng" }).click();
    await openPanel(page);
    await value(page, "Sửa nội dung", "unfinished edit");
    await page.evaluate(() => { window.records[0].version = 9; window.remount(); });
    await openPanel(page);
    await value(page, "Ý tưởng mới", "unfinished quick");
    await value(page, "Sửa nội dung", "unfinished edit");
    assert.equal(await page.locator('[data-idea-id="a1"]').count(), 1);
    await page.getByText("Phiên bản gốc: 1", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Lưu nội dung" }).click();
    await page.getByRole("alert").filter({ hasText: "Xung đột" }).waitFor();
    const calls = await mutations(page);
    assert.equal(calls.length, 1); assert.equal(calls[0].body.expected_version, 1);
    assert.ok(calls[0].path.endsWith("/a1"));
  },
  "Switching from project A to B hides A's draft, preserves independent B input, and restores A's draft on return.": async ({ page, origin }) => {
    await start(page, origin); await edit(page, "A edit");
    await page.getByLabel("Ý tưởng mới", { exact: true }).fill("A quick");
    await choose(page, "B"); await listReady(page, "Server B");
    await value(page, "Ý tưởng mới", "");
    assert.equal(await page.getByLabel("Sửa nội dung", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Server A", { exact: true }).count(), 0);
    await page.getByLabel("Ý tưởng mới", { exact: true }).fill("B quick");
    await choose(page, "A");
    await value(page, "Ý tưởng mới", "A quick"); await value(page, "Sửa nội dung", "A edit");
    await choose(page, "B"); await value(page, "Ý tưởng mới", "B quick");
    assert.equal((await mutations(page)).length, 0);
  },
  "Delayed reads and mutation responses from project A cannot replace project B's list or clear project B's draft.": async ({ page, origin }) => {
    await page.goto(origin);
    await page.getByRole("button", { name: "Ý tưởng", exact: true }).waitFor();
    await page.evaluate(() => { window.control.holdRead = "A"; });
    await openPanel(page);
    await page.waitForFunction(() => window.readWaiters.length === 1);
    await page.getByLabel("Ý tưởng mới", { exact: true }).fill("A quick");
    await choose(page, "B"); await listReady(page, "Server B");
    await page.getByLabel("Ý tưởng mới", { exact: true }).fill("B preserved");
    await page.evaluate(() => window.releaseReads());
    await value(page, "Ý tưởng mới", "B preserved");
    assert.equal(await page.getByText("Server A", { exact: true }).count(), 0);
    await choose(page, "A");
    await page.getByRole("button", { name: "Thử lại", exact: true }).click();
    await listReady(page, "Server A");
    await page.evaluate(() => { window.control.holdWrite = true; });
    await page.getByRole("button", { name: "Thêm ý tưởng" }).click();
    await page.waitForFunction(() => window.writeWaiters.length === 1);
    await choose(page, "B"); await listReady(page, "Server B");
    await page.evaluate(() => window.releaseWrites());
    await page.waitForFunction(() => window.records.some(record => record.content === "A quick"));
    await value(page, "Ý tưởng mới", "B preserved");
    assert.equal(await page.getByText("A quick", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Server A", { exact: true }).count(), 0);
    await choose(page, "A"); await value(page, "Ý tưởng mới", "A quick");
    await unconfirmed(page);
  },
  "A 409 preserves the entire edit, exposes a conflict and an explicit server comparison action, and causes no automatic version replacement or mutation retry.": async ({ page, origin }) => {
    await start(page, origin); await edit(page, "my entire edit\nincluding later lines");
    await page.evaluate(() => { Object.assign(window.records[0], { content: "remote edit", version: 7 }); });
    await page.getByRole("button", { name: "Lưu nội dung" }).click();
    await page.getByRole("button", { name: "Tải bản server để đối chiếu" }).click();
    await page.getByRole("complementary", { name: "Bản server" }).getByText("remote edit", { exact: true }).waitFor();
    await value(page, "Sửa nội dung", "my entire edit\nincluding later lines");
    await page.getByText("Phiên bản gốc: 1", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Đóng Ý tưởng" }).click();
    await page.evaluate(() => window.remount()); await openPanel(page);
    await value(page, "Sửa nội dung", "my entire edit\nincluding later lines");
    await page.getByRole("alert").filter({ hasText: "Xung đột" }).waitFor();
    const calls = await mutations(page);
    assert.equal(calls.length, 1); assert.equal(calls[0].body.expected_version, 1);
  },
  "Typing after a save starts preserves the later input when success acknowledges only the submitted snapshot.": async ({ page, origin }) => {
    await start(page, origin); await listReady(page, "Server A");
    await page.getByLabel("Ý tưởng mới", { exact: true }).fill("submitted quick");
    await page.evaluate(() => { window.control.holdWrite = true; });
    await page.getByRole("button", { name: "Thêm ý tưởng" }).click();
    await page.waitForFunction(() => window.writeWaiters.length === 1);
    await page.getByLabel("Ý tưởng mới", { exact: true }).fill("newer quick");
    await page.evaluate(() => window.releaseWrites());
    await page.getByRole("status").filter({ hasText: "Đã lưu bản đã gửi" }).waitFor();
    await value(page, "Ý tưởng mới", "newer quick");
    await edit(page, "submitted edit");
    await page.evaluate(() => { window.control.holdWrite = true; });
    await page.getByRole("button", { name: "Lưu nội dung" }).click();
    await page.waitForFunction(() => window.writeWaiters.length === 1);
    await page.getByLabel("Sửa nội dung", { exact: true }).fill("newer edit");
    await page.evaluate(() => window.releaseWrites());
    await page.getByRole("status").filter({ hasText: "Đã lưu bản đã gửi" }).waitFor();
    await value(page, "Sửa nội dung", "newer edit");
    await page.getByText("Phiên bản gốc: 1", { exact: true }).waitFor();
    const calls = await mutations(page);
    assert.deepEqual(calls.map(call => call.body.content), ["submitted quick", "submitted edit"]);
  },
  "Network failure, server failure, and project removal preserve drafts and visibly report that saving is unconfirmed.": async ({ page, origin }) => {
    for (const mode of ["offline", "server", "removed"]) {
      await start(page, origin); await edit(page, "retained edit");
      await page.getByLabel("Ý tưởng mới", { exact: true }).fill("retained quick");
      await page.evaluate(mode => { window.control.fail = mode; }, mode);
      await page.getByRole("button", { name: "Lưu nội dung" }).click();
      await unconfirmed(page);
      await page.evaluate(() => { window.control.fail = null; window.remount(); });
      await openPanel(page);
      await value(page, "Ý tưởng mới", "retained quick");
      await value(page, "Sửa nội dung", "retained edit");
      await unconfirmed(page);
      assert.equal((await mutations(page)).length, 1);
    }
  },
  "A response lost after a possible commit causes read reconciliation when available before a user retries, and never automatically replays POST, PATCH, or DELETE.": async ({ page, origin }) => {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      await start(page, origin); await listReady(page, "Server A");
      if (method === "POST") await page.getByLabel("Ý tưởng mới", { exact: true }).fill("uncertain quick");
      if (method === "PATCH") await edit(page, "uncertain edit");
      await page.evaluate(() => { window.control.loss = true; });
      if (method === "POST") await page.getByRole("button", { name: "Thêm ý tưởng" }).click();
      if (method === "PATCH") await page.getByRole("button", { name: "Lưu nội dung" }).click();
      if (method === "DELETE") {
        await page.locator('[data-idea-id="a1"]').getByRole("button", { name: "Xóa", exact: true }).click();
        await page.getByRole("button", { name: "Xác nhận xóa", exact: true }).click();
      }
      await unconfirmed(page);
      assert.equal((await mutations(page)).length, 1);
      await page.evaluate(() => { window.control.loss = false; });
      // The first attempted retry reads only. A separate explicit click would be needed to write.
      if (method === "POST") await page.getByRole("button", { name: "Thêm ý tưởng" }).click();
      else if (method === "PATCH") await page.getByRole("button", { name: "Lưu nội dung" }).click();
      else await page.getByRole("button", { name: "Xác nhận xóa", exact: true }).click();
      await page.getByRole("note").filter({ hasText: "Đã tải dữ liệu để đối chiếu" }).waitFor();
      const calls = await page.evaluate(() => window.calls.filter(call => call.path.includes("/ideas")));
      assert.equal(calls.filter(call => call.method !== "GET").length, 1);
      assert.equal(calls.at(-1).method, "GET");
      await unconfirmed(page);
      if (method === "POST") {
        await value(page, "Ý tưởng mới", "uncertain quick");
        await page.getByRole("note").filter({ hasText: "Gửi lại có thể tạo bản trùng" }).waitFor();
      }
      if (method === "PATCH") await value(page, "Sửa nội dung", "uncertain edit");
      const records = await page.evaluate(() => window.records);
      assert.ok(method === "POST" ? records.some(item => item.content === "uncertain quick")
        : method === "PATCH" ? records.some(item => item.content === "uncertain edit") : !records.some(item => item.id === "a1"));
    }
  }
};
