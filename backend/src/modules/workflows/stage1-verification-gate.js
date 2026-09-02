import { ConfigurationError } from "../../shared/errors.js";
import { buildVerificationPlan } from "../verification/verification-plan-builder.js";

/** Verify a task commit and merge only after every requested check passes. */
export function createStage1VerificationGate({ verificationOrchestrator, gitService, statusStore, protocolStorage, onStatusChange = () => {}, planBuilder = buildVerificationPlan } = {}) {
  if (typeof verificationOrchestrator?.run !== "function") throw new ConfigurationError("Verification gate requires a Verification Orchestrator.");
  if (typeof gitService?.merge !== "function") throw new ConfigurationError("Verification gate requires Git Service merge.");
  return Object.freeze({ verifyAndMerge });

  async function verifyAndMerge({ taskId, projectId, commitId, branch, target = "main", filesChanged, scope = "targeted", includeTests = false } = {}) {
    const plan = planBuilder({ commitId, filesChanged, scope, includeTests });
    const verification = await verificationOrchestrator.run(plan, { taskId, ticketId: taskId });
    await protocolStorage?.save(`task/${taskId}/verify_result`, verification, { schemaId: "https://forge.local/schemas/agent/verify-result.schema.json" });
    if (!verification.ready_for_review) return { status: "verification_failed", verification, merged: false };
    try {
      const merge = await gitService.merge(branch, { target, noFastForward: true });
      const updated = statusStore?.updateStatus ? statusStore.updateStatus(taskId, "done", { reason: "verified_and_merged", commit_id: commitId, merge }, { expectedCurrentStatus: "reviewing" }) : undefined;
      await onStatusChange({ projectId, ticketId: taskId, status: "done" });
      return { status: "merged", verification, merge, merged: true, runtimeStatus: updated };
    } catch (error) {
      if (error?.code === "GIT_MERGE_CONFLICT") { await gitService.abortMerge?.().catch(() => {});
      const status = statusStore?.updateStatus ? statusStore.updateStatus(taskId, "needs_human_review", { reason: "merge_conflict", error: error.message }, { expectedCurrentStatus: "reviewing" }) : undefined;
      await onStatusChange({ projectId, ticketId: taskId, status: "needs_human_review", error: error.message });
      return { status: "merge_conflict", verification, merged: false, error: error.message, runtimeStatus: status }; }
      throw error;
    }
  }
}
