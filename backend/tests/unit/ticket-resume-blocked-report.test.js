// Ensures blocked tickets can request owner action without committing unfinished work.
import assert from "node:assert/strict";
import test from "node:test";
import { checkpointedRegistry, createResumeState } from "../../src/modules/supervisor/ticket-resume.js";
import { createReportDoneTool } from "../../src/tools/agent-report-tool.js";

// Builds a resumed ticket with uncommitted edits and the real governed report tool.
function blockedReportFixture() {
  const reports = [];
  const checkpoints = [];
  const reportService = {
    buildFinalReport: async (report) => ({ ...report }),
    saveReport: async (taskId, report) => reports.push({ taskId, report }),
    writeReportFile: async (taskId, report) => reports.push({ taskId, report })
  };
  const store = {
    save: async (payload) => checkpoints.push(payload),
    complete: async (taskId, payload) => checkpoints.push({ taskId, ...payload })
  };
  const state = createResumeState({ status: "in_progress", changed_paths: ["unfinished.js"], completed_tools: ["edit_diff"] });
  const wrapped = checkpointedRegistry({ store, registry: { report_done: createReportDoneTool({ reportService }) }, taskId: "T-BLOCKED", resumeState: state });
  const context = { ticket: { id: "T-BLOCKED", acceptance_criteria: ["Approved contract required"] }, changed_paths: ["unfinished.js"] };
  return { reports, checkpoints, state, wrapped, context };
}

test("resumed uncommitted work preserves a blocked report and raises CODER_BLOCKED", async () => {
  const { reports, checkpoints, state, wrapped, context } = blockedReportFixture();
  await assert.rejects(wrapped.report_done.execute({
    status: "blocked",
    summary: "Approved management contract is unavailable",
    blocker: { reason_code: "ACCESS_REQUIRED", owner_action: "Supply the approved contract artifacts" },
    evidence: [{ type: "source", reference: "backend/multi-project-lifecycle.md", result: "Transport acceptance remains pending" }]
  }, context), { code: "CODER_BLOCKED" });
  assert.equal(reports.length, 2);
  assert.equal(reports[0].report.status, "needs_human_review");
  assert.equal(reports[0].report.agent_report.status, "blocked");
  assert.deepEqual(reports[0].report.filesChanged, ["unfinished.js"]);
  assert.equal(reports[0].report.criteria_check[0].node_verified, null);
  assert.equal(checkpoints.length, 0);
  assert.deepEqual(state.completedTools, ["edit_diff"]);
});

test("blocked status still requires valid blocker evidence", async () => {
  const { reports, wrapped, context } = blockedReportFixture();
  await assert.rejects(wrapped.report_done.execute({ status: "blocked", summary: "Missing evidence" }, context), { code: "INPUT_INVALID" });
  assert.equal(reports.length, 0);
});

test("a blocked-report exception does not waive the commit gate for completion", async () => {
  const { reports, wrapped, context } = blockedReportFixture();
  for (const status of [undefined, "completed"]) {
    await assert.rejects(wrapped.report_done.execute({ status, summary: "Done" }, context), { code: "COMMIT_MISSING" });
  }
  assert.equal(reports.length, 0);
});
