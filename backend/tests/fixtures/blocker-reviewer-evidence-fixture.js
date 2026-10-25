/** Creates a blocked ticket with a real committed source and historical failed
 * artifact, allowing independent review evidence to be checked without a live
 * SDK, production database, or mutation of the shared repository Git index. */
import { execFile as callback } from "node:child_process";
import { promisify } from "node:util";
import { blockerRecoveryFixture } from "./blocker-recovery-fixture.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

const execFile = promisify(callback);

/** Supplies all recovery roles with source-bound fixtures while retaining the
 * original Coder checkpoint and real recovery ledger across worker restarts. */
export async function blockerReviewerEvidenceFixture(options = {}) {
  let subject;
  const result = { findings: ["The independent report resolves the narrow source question."], implementation_steps: ["Continue the approved handler."],
    verification_steps: ["Run the focused handler test."], admission: { status: "within_existing_permissions", rationale: "No new permission or denied diagnostic is needed." } };
  const f = await blockerRecoveryFixture({ ...options, investigate: async (job, resolution) => {
    if (options.investigate) return options.investigate(job, resolution, subject);
    if (job.stage === "reviewer") return { action: "review_evidence_provided", summary: "Committed handler inspected independently.",
      review_evidence: { purpose: "blocker_evidence", subject, outcome: "completed", summary: "Committed handler matches recorded evidence.",
        observations: ["The committed handler checksum matches the issued source evidence."], missing_evidence: [], findings: [], finding_updates: [] }, evidence: [f.evidence] };
    if (job.stage === "architecture_manager" && job.reviewer_evidence?.status !== "completed") return request();
    return job.stage === "sprint_leader" && !job.architecture_response
      ? { action: "architecture_required", summary: "Decide the exact verification attribution question." }
      : { ...resolution, technical_result: result };
  } });
  const projectRoot = f.base.workspace.projectRoot;
  await execFile("git", ["init", "--quiet", projectRoot]);
  await execFile("git", ["-C", projectRoot, "add", "backend/src/handler.js"]);
  await execFile("git", ["-C", projectRoot, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  const { stdout } = await execFile("git", ["-C", projectRoot, "rev-parse", "HEAD"]);
  subject = { commit_sha: stdout.trim(), artifact_id: "ARTIFACT-RETAINED" };
  const artifactPath = ".forge/runtime/ticket-verification/TASK/artifacts/ARTIFACT-RETAINED.json";
  const artifact = { ...subject, base_sha: subject.commit_sha, task_id: "TASK", project_id: "P", source_revision: "OLD", status: "failed",
    changed_paths: [f.evidence.path], file_checksums: { [f.evidence.path]: `sha256:${f.evidence.sha256}` }, commands: [] };
  await f.base.fileService.atomicWrite({ path: artifactPath, content: JSON.stringify(artifact), replace: false });

  /** Models AM's explicit Reviewer assignment under the common disposition
   * schema; source identity never comes from narrative interpretation. */
  function request() {
    return { action: "reconciliation_required", summary: "Need independent source attribution.", guidance: "Read committed evidence without executing diagnostics.",
      reconciliation: { kind: "source_revision", prerequisite: "Independent report bound to the retained commit and artifact.",
        completed_checks: ["The technical scope is settled."], next_check: "Reviewer inspects the exact recorded source.",
        waiting_for: [{ owner: "reviewer", operation: "inspect", question: "Compare the committed handler checksum with the verification artifact.", subject }] } };
  }

  /** Builds the same immutable receipt inventory issued by production recovery
   * so direct SDK/tool tests can run without bypassing source-bound validation. */
  async function assignedJob() {
    const internal = createFileService({ projectRoot, role: "system_engineer" });
    const receipt = await internal.readForIndex({ path: artifactPath });
    return { id: "J", stage: "reviewer", status: "invoking", history: [], reviewer_evidence: { id: "REVIEW-WORK", request: request().reconciliation.waiting_for[0],
      architecture_actor: { agent_id: "AM", role: "architecture_manager" }, status: "pending" },
    request: { task_id: "TASK", project_id: "P", payload: { execution_id: "EXEC" }, ticket: f.ticket },
    ticket_progress: { verification: { status: "missing", source_revision: "CURRENT", commit_sha: null, receipt_index: [{ type: "artifacts", artifact_id: subject.artifact_id,
      commit_sha: subject.commit_sha, source_revision: "OLD", evidence_ref: artifactPath, receipt_sha256: receipt.sha256,
      provenance: "historical_ticket_source", diagnostic_only: true }] } } };
  }
  return Object.assign(f, { subject, artifact, artifactPath, projectRoot, request, assignedJob });
}
