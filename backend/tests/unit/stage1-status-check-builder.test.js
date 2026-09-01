import assert from "node:assert/strict";
import test from "node:test";
import { buildStatusCheck } from "../../src/modules/workflows/stage1-status-check-builder.js";
test("builds status_check with coder-scoped criteria and changed files", () => { const e = buildStatusCheck({ taskId: "T-1", stepId: 4, criteria: ["Page exists", "Build succeeds"], filesChanged: [{ path: "ui/nextjs/app/page.jsx", action: "created" }], createRequestId: () => "22222222-2222-4222-8222-222222222222" }); assert.equal(e.type, "status_check"); assert.deepEqual(e.payload.acceptance_criteria, ["Page exists"]); assert.deepEqual(e.payload.files_changed, [{ path: "ui/nextjs/app/page.jsx", action: "created" }]); });
