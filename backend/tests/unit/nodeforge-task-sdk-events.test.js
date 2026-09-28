// Verifies that a blocked commit is reported as the real ticket failure.
import assert from "node:assert/strict";
import test from "node:test";
import { assertTicketExecutionCompleted } from "../../src/modules/supervisor/nodeforge-task-sdk-events.js";

test("blocked commit takes precedence over a missing completion report", () => {
  const events = [
    { tool: "edit_diff", status: "success" },
    { tool: "commit_changes", status: "failed", error: { message: "This action was rejected due to unacceptable risk." } }
  ];
  assert.throws(() => assertTicketExecutionCompleted(events), (error) => error.code === "COMMIT_APPROVAL_REJECTED" && error.tool === "commit_changes");
});

test("an absent report without a failed commit keeps its existing error", () => {
  assert.throws(() => assertTicketExecutionCompleted([{ tool: "edit_diff", status: "success" }]), (error) => error.code === "AGENT_REPORT_MISSING");
});
