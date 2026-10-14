// Verifies plan approval UI names Registry recovery and submits the exact owner-reviewed identity.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("plan approval notice and modal describe Registry rather than legacy Roadmap recovery", async () => {
  const notice = await readFile(new URL("../components/pending-plan-approval.jsx", import.meta.url), "utf8");
  const modal = await readFile(new URL("../components/plan-review-modal.jsx", import.meta.url), "utf8");
  assert.ok(notice.includes("Sprint Plan cần khôi phục binding trong Registry"));
  assert.doesNotMatch(`${notice}\n${modal}`, /Sprint Plan chưa được thêm vào roadmap/);
  assert.ok(modal.includes("await client.handoffPlan(projectId, plan, token)"));
  assert.ok(modal.includes("current.sha256 !== plan.sha256"));
  assert.ok(modal.includes('result.status !== "handed_to_sprint_leader"'));
  assert.doesNotMatch(modal, /postOwnerMessage|approvalRevision:/);
});

test("review progress names Sprint Leader only during the owner-approved handoff", async () => {
  const modal = await readFile(new URL("../components/plan-review-modal.jsx", import.meta.url), "utf8");
  assert.match(modal, /setPlan\(\{ \.\.\.current, status: "approved" \}\);\s*setHandoffPending\(true\);\s*const result = await client\.handoffPlan/);
  assert.match(modal, /finally \{ submitting\.current = false; setHandoffPending\(false\); \}/);
  assert.match(modal, /handoffPending \? "Owner đã duyệt plan\. Node đang chuyển cho Sprint Leader lập Sprint Plan; chưa RUN ticket\." : "Đang lưu hoặc kiểm tra revision\/quyết định của owner…"/);
  assert.doesNotMatch(modal, /Đang xử lý handoff với Sprint Leader…/);
});
