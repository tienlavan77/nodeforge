// Re-arms Architecture once per durable owner choice without relaunching Coder or fabricating contract approval.

// Defines createBlockerOwnerFollowUp function behavior for blocker-owner-follow-up.js.
export function createBlockerOwnerFollowUp({ store, clock, deadlineMs }) {
  return followOwnerDecision;

  // Preserves the original execution and investigation history while fulfilling a recorded direction choice.
  async function followOwnerDecision({ projectId, taskId, executionId, jobId, decision }) {
    if (!decision?.decision_id || !decision.actor || !decision.option_id) return null;
    return store.withLock("blocker.recovery", async () => {
      const ledger = (await store.list("blocker.recovery")).find((entry) => entry.project_id === projectId && entry.task_id === taskId && entry.execution_id === executionId);
      const job = ledger?.jobs.find((entry) => entry.id === jobId);
      if (!job || ledger.cancelled) return null;
      if (job.fulfillment_decision_id === decision.decision_id) return structuredClone(job);
      if (job.status !== "owner_required") return null;
      job.owner_decisions = [...(job.owner_decisions ?? []).filter((entry) => entry.decision_id !== decision.decision_id), structuredClone(decision)];
      job.fulfillment_decision_id = decision.decision_id;
      job.history.push({ stage: "owner_decision", decision: structuredClone(decision), completed_at: clock() });
      job.stage = "architecture_manager";
      job.status = "pending";
      delete job.resolution;
      delete job.outcome_reason;
      delete job.last_error;
      delete job.validation_feedback;
      ledger.deadline_at = clock() + deadlineMs;
      await store.save("blocker.recovery", ledger);
      return structuredClone(job);
    });
  }
}
