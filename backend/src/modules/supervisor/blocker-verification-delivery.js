// Returns parked evidence-delivery work to SL when Node can supply readable current/history receipts and a baseline inventory.
import { createHash } from "node:crypto";
import { readBlockerVerificationEvidence } from "./blocker-verification-evidence.js";
import { createBlockerEvidenceFiles } from "./blocker-evidence-files.js";
import { BLOCKER_RECEIPT_MAX_BYTES } from "./blocker-evidence-limits.js";

// Rechecks internal evidence waits without relaunching Coder, changing authority or manufacturing historical test results.
export function createBlockerVerificationDelivery({ inspect, clock = Date.now, projectLogger = () => {} }) {
  const polls = new Map();
  return async (job) => {
    const work = job.resolution?.reconciliation;
    if (job.outcome_reason !== "technical_reconciliation_waiting_for_evidence" || !["tooling", "source_revision"].includes(work?.kind)
      || !work.waiting_for?.length || !work.waiting_for.every((entry) => typeof entry === "string" || entry.owner === "external" && entry.operation !== "execute")) return false;
    const now = clock();
    if (polls.has(job.id) && now - polls.get(job.id) < 30_000) return false;
    polls.set(job.id, now);
    const authority = await inspect(job);
    const workspace = authority?.workspace;
    if (!workspace?.executionContexts?.load || !(workspace.projectRoot ?? workspace.path)) return false;
    const context = await workspace.executionContexts.load(job.request.task_id);
    const verification = await readBlockerVerificationEvidence({ job, workspace, context, checkpoint: authority.checkpoint });
    if (!["missing", "observed"].includes(verification.status)) return false;
    const receipts = verification.receipt_index ?? [...verification.checks, ...verification.historical_checks, ...verification.historical_artifacts];
    if (!receipts.length) return false;
    const identity = createHash("sha256").update(JSON.stringify({ version: 1, source: verification.source_revision, commit: verification.commit_sha,
      receipts: receipts.map(({ evidence_ref, receipt_sha256 }) => ({ evidence_ref, receipt_sha256 })).sort((a, b) => a.evidence_ref.localeCompare(b.evidence_ref)),
      baseline: verification.baseline_evidence })).digest("hex");
    if (job.verification_delivery_digest === identity || job.ticket_progress?.verification?.delivery?.sha256 === identity) return false;
    const { files } = createBlockerEvidenceFiles({ files: workspace.fileService, projectRoot: workspace.projectRoot ?? workspace.path,
      profile: { role: "sprint_leader" }, taskId: job.request.task_id, job: { ...job, ticket_progress: { ...job.ticket_progress, verification } } });
    for (const receipt of receipts) await files.readForIndex({ path: receipt.evidence_ref, maxBytes: BLOCKER_RECEIPT_MAX_BYTES });
    const current = await workspace.executionContexts.load(job.request.task_id);
    if (["version", "source_revision", "review_commit_sha", "manifest_sha", "base_sha", "project_id"].some((key) => current?.[key] !== context[key])) return false;
    verification.delivery = { status: "readable", sha256: identity, checked_refs: receipts.map((entry) => entry.evidence_ref) };
    job.verification_delivery_digest = identity;
    job.ticket_progress = { ...job.ticket_progress, verification };
    job.history.push({ stage: "sprint_leader", event: "verification_evidence_delivered", completed_at: now, previous_resolution: job.resolution });
    delete job.resolution;
    delete job.validation_feedback;
    projectLogger({ event_name: "supervisor.blocker_verification_evidence_ready", level: "info", status: "success", task_id: job.request.task_id,
      message: "Current and historical verification receipts are readable; baseline inventory supplied. Returning to Sprint Leader at the retained checkpoint.",
      payload: { job_id: job.id, baseline_status: verification.baseline_evidence.status, evidence_refs: verification.delivery.checked_refs } });
    return true;
  };
}
