import assert from "node:assert/strict";
import test from "node:test";
import { buildUsageQuery } from "../../src/modules/workflows/stage1-usage-query-builder.js";

test("builds a validated usage_query for unwired created files", () => {
  const result = buildUsageQuery({ taskId: "T-1", stepId: 3, parentId: "11111111-1111-4111-8111-111111111111", unwiredFiles: [{ path: "ui/nextjs/app/agent/page.jsx" }], createRequestId: () => "22222222-2222-4222-8222-222222222222", clock: () => new Date("2026-09-01T00:00:00Z") });
  assert.equal(result.type, "usage_query");
  assert.deepEqual(result.payload.unwired_files, [{ path: "ui/nextjs/app/agent/page.jsx", status: "unwired", imported_by: [] }]);
});
