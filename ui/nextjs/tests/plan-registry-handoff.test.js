// Verifies plan approval UI names Registry recovery and submits the exact owner-reviewed identity.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("plan approval notice and modal describe Registry rather than legacy Roadmap recovery", async () => {
  const notice = await readFile(new URL("../components/pending-plan-approval.jsx", import.meta.url), "utf8");
  const modal = await readFile(new URL("../components/plan-review-modal.jsx", import.meta.url), "utf8");
  assert.ok(notice.includes("Sprint Plan cần khôi phục binding trong Registry"));
  assert.ok(modal.includes("Sprint Plan chưa hiển thị trong Registry"));
  assert.doesNotMatch(`${notice}\n${modal}`, /Sprint Plan chưa được thêm vào roadmap/);
  assert.ok(modal.includes("approvalRevision: plan.revision, approvalSha256: plan.sha256"));
  assert.ok(modal.includes("await client.listSprints(projectId)"));
  assert.ok(modal.includes('result?.payload?.status !== "handed_to_sprint_leader"'));
});
