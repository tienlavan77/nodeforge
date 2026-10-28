// Lets coordinating agents inspect Node-issued verification receipts without exposing other runtime files.
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { createFileService } from "../../infrastructure/filesystem/file-service.js";
import { createRoleFileService } from "../../infrastructure/filesystem/file-service-role-policy.js";
import { blockerPromptContextGrant, assertBlockerPromptContext } from "./blocker-prompt-context.js";
import { BLOCKER_RECEIPT_MAX_BYTES } from "./blocker-evidence-limits.js";

// Adds exact, read-only receipt grants to the ordinary role service for the current recovery assignment.
export function createBlockerEvidenceFiles({ files, projectRoot, profile, taskId, job }) {
  const verification = job?.ticket_progress?.verification;
  const grants = new Map();
  const projectId = job?.request?.project_id;
  if (["sprint_leader", "architecture_manager", "reviewer"].includes(profile.role)
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(taskId ?? "") && job?.request?.task_id === taskId
    && projectId && ["observed", "missing"].includes(verification?.status)) {
    const prefix = `${statePath()}/ticket-verification/${taskId}`;
    for (const [entry, directory, key, pattern] of [
      [verification.status === "observed" ? verification.job : null, "jobs", "job_id", /^VERIFY-[A-Za-z0-9-]+$/],
      [verification.status === "observed" ? verification.diagnostic : null, "artifacts", "artifact_id", /^ARTIFACT-[A-Za-z0-9-]+$/],
      ...(verification.historical_jobs ?? []).map((record) => [record, "jobs", "job_id", /^VERIFY-[A-Za-z0-9-]+$/]),
      ...(verification.historical_artifacts ?? []).map((artifact) => [artifact, "artifacts", "artifact_id", /^ARTIFACT-[A-Za-z0-9-]+$/]),
      ...(verification.receipt_index ?? []).map((entry) => entry.type === "jobs" ? [entry, "jobs", "job_id", /^VERIFY-[A-Za-z0-9-]+$/]
        : entry.type === "artifacts" ? [entry, "artifacts", "artifact_id", /^ARTIFACT-[A-Za-z0-9-]+$/]
          : [entry, "checks", "check_id", /^CHECK-[A-Za-z0-9-]+$/]),
      ...[...(verification.checks ?? []), ...(verification.historical_checks ?? [])].map((check) => [check, "checks", "check_id", /^CHECK-[A-Za-z0-9-]+$/])
    ]) {
      if (pattern.test(entry?.[key] ?? "") && entry.evidence_ref === `${prefix}/${directory}/${entry[key]}.json`)
        grants.set(entry.evidence_ref, entry);
    }
  }
  // Distinguishes exact Node-issued receipt reads from ordinary source discovery.
  const contextGrant = (path) => blockerPromptContextGrant(job, taskId, profile, path);
  // Defines isEvidencePath function behavior for blocker-evidence-files.js.
  const isEvidencePath = (path) => grants.has(path) || Boolean(contextGrant(path));
  if (!grants.size && !job?.prompt_context_refs?.length) return { files, isEvidencePath };
  const internalFiles = createRoleFileService({ projectRoot, role: "system_engineer",
    fileService: createFileService({ projectRoot, role: "system_engineer" }) });
  return { isEvidencePath, files: Object.freeze({ ...files,
    assertReadPath: (path) => isEvidencePath(path) ? internalFiles.assertReadPath(path) : files.assertReadPath(path),
    readForIndex: async (input) => isEvidencePath(input?.path) ? readEvidence(input) : files.readForIndex(input),
    readFile: async (input) => isEvidencePath(input?.path) ? (await readEvidence(input)).content : files.readFile(input)
  }) };

  // Checks the receipt's persisted identity as well as its path before returning its original bytes and checksum.
  async function readEvidence(input) {
    const context = contextGrant(input.path);
    const file = await internalFiles.readForIndex(context ? input : { ...input, maxBytes: BLOCKER_RECEIPT_MAX_BYTES });
    if (context) return assertBlockerPromptContext(file, job, context);
    const receipt = JSON.parse(file.content);
    const filename = input.path.split("/").at(-1);
    const identity = input.path.includes("/artifacts/") ? receipt.artifact_id
      : input.path.includes("/jobs/") ? receipt.job_id : receipt.check_id;
    const check = input.path.includes("/checks/");
    const declared = grants.get(input.path);
    const historical = declared?.diagnostic_only === true && declared.provenance === "historical_ticket_source"
      && /^sha256:[a-f0-9]{64}$/.test(declared.receipt_sha256 ?? "");
    const expected = historical ? declared : verification;
    const preCommit = check && expected.commit_sha === null && receipt.pre_commit === true;
    const projectMismatch = input.path.includes("/artifacts/") ? receipt.project_id !== projectId
      : receipt.project_id !== undefined && receipt.project_id !== projectId;
    if (receipt.task_id !== taskId || projectMismatch || `${identity}.json` !== filename
      || (!expected.commit_sha && !preCommit) || receipt.commit_sha !== expected.commit_sha
      || check && (declared.source_revision !== expected.source_revision || declared.commit_sha !== expected.commit_sha)
      || !expected.source_revision || receipt.source_revision !== expected.source_revision
      || declared.receipt_sha256 && declared.receipt_sha256 !== file.sha256) {
      throw Object.assign(new Error("Verification evidence no longer matches the recovery assignment."), { code: "VERIFY_SOURCE_STALE" });
    }
    return file;
  }
}
