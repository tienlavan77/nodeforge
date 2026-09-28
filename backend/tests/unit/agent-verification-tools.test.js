// Verifies that Node chooses checks relevant to a Coder's changed files.
import assert from "node:assert/strict";
import test from "node:test";
import { createRunTestTool } from "../../src/tools/agent-verification-tools.js";

test("run_test checks changed UI tests and frontend build", async () => {
  const requests = [];
  const tool = createRunTestTool({ testService: { startTests: (request) => { requests.push(request); return { job_id: "TEST-JOB-1", status: "running" }; } } });
  await tool.execute({}, { task_id: "NF-UI-CONV-002", changed_paths: ["ui/nextjs/components/Dialog.jsx", "ui/nextjs/tests/dialog.test.js"] });
  assert.equal(requests[0].command, "node --test ui/nextjs/tests/dialog.test.js && pnpm --dir ui/nextjs build");
});

test("run_test keeps backend checks and rejects agent-supplied commands", async () => {
  const requests = [];
  const tool = createRunTestTool({ testService: { startTests: (request) => { requests.push(request); return { job_id: "TEST-JOB-2", status: "running" }; } } });
  await tool.execute({}, { task_id: "BACKEND-1", changed_paths: ["backend/src/example.js"] });
  assert.equal(requests[0].command, "node --test backend/tests/tools/*.test.js");
  await assert.rejects(() => tool.execute({ command: "echo unsafe" }, { task_id: "BACKEND-1" }), (error) => error.code === "INPUT_INVALID");
});
