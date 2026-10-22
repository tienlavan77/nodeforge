// Verifies that a blocked commit is reported as the real ticket failure.
import assert from "node:assert/strict";
import test from "node:test";
import { assertTicketExecutionCompleted, collectToolCalls } from "../../src/modules/supervisor/nodeforge-task-sdk-events.js";

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

// A verified response is sufficient even when the agent also replays its existing report without edits.
test("evidence-only response completes with or without replaying the saved report", () => {
  for (const report of [[], [{ tool: "report_done", status: "success" }], [{ tool: "report_done", status: "failed", error_code: "CODER_REPORT_CONFLICT" }]])
    assert.doesNotThrow(() => assertTicketExecutionCompleted([...report, { tool: "respond_to_review", status: "success" }]));
  assert.throws(() => assertTicketExecutionCompleted([{ tool: "respond_to_review", status: "failed", error_code: "REVIEW_RESPONSE_STALE" }],
    { priorTools: ["respond_to_review"] }), { code: "AGENT_REPORT_MISSING" });
});

test("a resumed report accepts persisted successful edit and commit turns", () => {
  assert.doesNotThrow(() => assertTicketExecutionCompleted([{ tool: "report_done", status: "success" }], { priorTools: ["edit_diff", "commit_changes", "run_test"] }));
  assert.throws(() => assertTicketExecutionCompleted([{ tool: "read_file", status: "success" }], { priorTools: ["edit_diff", "commit_changes", "report_done"] }), (error) => error.code === "AGENT_REPORT_MISSING");
});

test("Claude flattened and MCP text results preserve the original report failure through Supervisor", () => {
  const diagnostic = { error_code: "VERIFY_BROWSER_SCENARIO_REQUIRED", message: "Approved browser assertions have no registered Node-owned scenario." };
  for (const content of [JSON.stringify(diagnostic), [{ type: "text", text: JSON.stringify(diagnostic) }]]) {
    const events = collectToolCalls([
      { type: "assistant", message: { content: [{ type: "tool_use", id: "report-call", name: "mcp__forge__report_done" }] } },
      { type: "user", message: { content: [{ type: "tool_result", id: "result-id", tool_use_id: "report-call", is_error: true, content }] } }
    ]);
    assert.equal(events[0].status, "failed");
    assert.equal(events[0].error_code, diagnostic.error_code);
    assert.throws(() => assertTicketExecutionCompleted(events), { code: diagnostic.error_code, message: diagnostic.message });
  }
});

test("unstructured tool errors retain the fallback and a corrected report may finish", () => {
  const messages = [
    { content: [{ type: "tool_use", id: "bad", name: "mcp__forge__report_done" }] },
    { content: [{ type: "tool_result", tool_use_id: "bad", is_error: true, content: "Provider failure" }] }
  ];
  assert.throws(() => assertTicketExecutionCompleted(collectToolCalls(messages)), { code: "REPORT_FAILED" });
  messages.push({ content: [{ type: "tool_use", id: "good", name: "mcp__forge__report_done" }] },
    { content: [{ type: "tool_result", tool_use_id: "good", content: "{}" }] });
  assert.doesNotThrow(() => assertTicketExecutionCompleted(collectToolCalls(messages), { priorTools: ["edit_diff", "commit_changes"] }));
});
