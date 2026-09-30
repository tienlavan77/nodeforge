// Ensures an agent completion report cannot bypass Node-owned ticket verification.
import assert from "node:assert/strict";
import test from "node:test";
import { createReportDoneTool } from "../../src/tools/agent-report-tool.js";

// Blocks report persistence if the ticket artifact is absent or mismatched.
test("report_done requires a passed artifact before saving a ticket report", async () => {
  let saved = false;
  const reportService = {
    buildFinalReport: async ({ verifyResult, filesChanged }) => ({ status: "completed", ticket: { id: "TICKET-1" }, criteria_check: [{ criterion: "build", node_verified: Boolean(verifyResult?.ready_for_review) }], files_changed: filesChanged }),
    saveReport: async () => { saved = true; },
    writeReportFile: async () => {}
  };
  const context = { ticket: { id: "TICKET-1", acceptance_criteria: ["build"] }, changed_paths: ["backend/src/agent-claimed.js"] };
  const blocked = createReportDoneTool({ reportService, verificationService: { assertPassedArtifact: async () => { throw Object.assign(new Error("missing"), { code: "VERIFY_ARTIFACT_MISMATCH" }); } } });
  await assert.rejects(blocked.execute({ summary: "Done" }, context), { code: "VERIFY_ARTIFACT_MISMATCH" });
  assert.equal(saved, false);
  const verified = createReportDoneTool({ reportService, verificationService: { assertPassedArtifact: async () => ({ artifact_id: "ARTIFACT-1", commit_sha: "a".repeat(40), file_checksums: { "backend/src/actual.js": "sha256:actual" } }) } });
  await verified.execute({ summary: "Done" }, context);
  assert.equal(saved, true);
  assert.deepEqual(context.changed_paths, ["backend/src/actual.js"]);
});
