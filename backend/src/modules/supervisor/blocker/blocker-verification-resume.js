// Rechecks Node-owned verification waits so terminal jobs return to SL without an Owner Resume click.
import { createHash } from "node:crypto";
import { readBlockerVerificationEvidence } from "./blocker-verification-evidence.js";

// Polls only retained verification waits and preserves execution, source and external prerequisite boundaries.
export function createBlockerVerificationResume({ inspect, clock = Date.now, projectLogger = () => {} }) {
  const polls = new Map();
  return async (job) => {
    if (job.outcome_reason !== "technical_reconciliation_waiting_for_evidence") return false;
    const previous = job.ticket_progress?.verification?.job;
    const waits = job.resolution?.reconciliation?.waiting_for;
    if (!previous?.job_id || !waits?.length || !waits.every((input) => {
      const question = typeof input === "string" ? input : input.question;
      return (typeof input === "string" || input.owner === "external" && input.operation !== "execute")
        && question?.includes(previous.job_id) && /terminal|status|result|kết quả|trạng thái/i.test(question);
    })) return false;
    const now = clock();
    if (polls.has(job.id) && now - polls.get(job.id) < 30_000) return false;
    polls.set(job.id, now);
    const authority = await inspect(job);
    if (!authority) return false;
    const context = await authority.workspace.executionContexts.load(job.request.task_id);
    const evidence = await readBlockerVerificationEvidence({ job, workspace: authority.workspace, context });
    const current = evidence.status === "observed" ? evidence.job : null;
    if (!current || !["passed", "failed"].includes(current.status)) return false;
    // Deduplicates terminal check evidence independently of incidental timestamps.
    const digest = (value) => createHash("sha256").update(JSON.stringify([value.job_id, value.status, value.artifact_id, value.error])).digest("hex");
    const identity = digest(current);
    if (identity === digest(previous) || identity === job.verification_wait_digest) return false;
    job.verification_wait_digest = identity;
    projectLogger({ event_name: "supervisor.blocker_verification_ready", level: "info", status: "success", task_id: job.request.task_id,
      message: "Verification reached a terminal result; returning its evidence to Sprint Leader at the retained checkpoint.",
      payload: { job_id: job.id, verification_job_id: current.job_id, verification_status: current.status } });
    return true;
  };
}
