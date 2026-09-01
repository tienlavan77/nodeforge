import assert from "node:assert/strict";
import test from "node:test";
import { createStage1ResponseRouter } from "../../src/modules/workflows/stage1-response-router.js";
const base = { role: "agent", request_id: "r", parent_id: "p" };
test("routes usage_needed", async () => { let received; const router = createStage1ResponseRouter({ onCodeNeeded: () => {}, onSubmitCode: () => {}, onUsageNeeded: (e,c) => { received={e,c}; return "exchange"; } }); assert.equal(await router.routeResponse({ ...base, type: "usage_needed", payload: { files_requested: ["ui/nextjs/app/NodeForgeApp.jsx"], reason: "Need wiring." } }, { taskId: "T-1" }), "exchange"); assert.deepEqual(received.e.payload.files_requested, ["ui/nextjs/app/NodeForgeApp.jsx"]); });
test("routes no_wiring_needed", async () => { const router = createStage1ResponseRouter({ onCodeNeeded: () => {}, onSubmitCode: () => {}, onNoWiringNeeded: (e) => e.payload.reason }); assert.equal(await router.routeResponse({ ...base, type: "no_wiring_needed", payload: { reason: "Standalone." } }), "Standalone."); });
