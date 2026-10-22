// Lets coordinating agents inspect Node-issued verification receipts without exposing other runtime files.
import { createFileService } from "../../infrastructure/filesystem/file-service.js";
import { createRoleFileService } from "../../infrastructure/filesystem/file-service-role-policy.js";

// Adds exact, read-only receipt grants to the ordinary role service for the current recovery assignment.
export function createBlockerEvidenceFiles({ files, projectRoot, profile, taskId, job }) {
  const verification = job?.ticket_progress?.verification;
  const grants = new Set();
  const projectId = job?.request?.project_id;
  if (["sprint_leader", "architecture_manager"].includes(profile.role)
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(taskId ?? "") && job?.request?.task_id === taskId
    && projectId && verification?.status === "observed") {
    const prefix = `.forge/runtime/ticket-verification/${taskId}`;
    for (const [entry, directory, key, pattern] of [
      [verification.job, "jobs", "job_id", /^VERIFY-[A-Za-z0-9-]+$/],
      [verification.diagnostic, "artifacts", "artifact_id", /^ARTIFACT-[A-Za-z0-9-]+$/],
      ...(verification.checks ?? []).map((check) => [check, "checks", "check_id", /^CHECK-[A-Za-z0-9-]+$/])
    ]) {
      if (pattern.test(entry?.[key] ?? "") && entry.evidence_ref === `${prefix}/${directory}/${entry[key]}.json`)
        grants.add(entry.evidence_ref);
    }
  }
  // Distinguishes exact Node-issued receipt reads from ordinary source discovery.
  const isEvidencePath = (path) => grants.has(path);
  if (!grants.size) return { files, isEvidencePath };
  const internalFiles = createRoleFileService({ projectRoot, role: "system_engineer",
    fileService: createFileService({ projectRoot, role: "system_engineer" }) });
  return { isEvidencePath, files: Object.freeze({ ...files,
    assertReadPath: (path) => isEvidencePath(path) ? internalFiles.assertReadPath(path) : files.assertReadPath(path),
    readForIndex: async (input) => isEvidencePath(input?.path) ? readEvidence(input) : files.readForIndex(input),
    readFile: async (input) => isEvidencePath(input?.path) ? (await readEvidence(input)).content : files.readFile(input)
  }) };

  // Checks the receipt's persisted identity as well as its path before returning its original bytes and checksum.
  async function readEvidence(input) {
    const file = await internalFiles.readForIndex(input);
    const receipt = JSON.parse(file.content);
    const filename = input.path.split("/").at(-1);
    const identity = input.path.includes("/artifacts/") ? receipt.artifact_id
      : input.path.includes("/jobs/") ? receipt.job_id : receipt.check_id;
    const projectMismatch = input.path.includes("/artifacts/") ? receipt.project_id !== projectId
      : receipt.project_id !== undefined && receipt.project_id !== projectId;
    if (receipt.task_id !== taskId || projectMismatch || `${identity}.json` !== filename
      || !verification.commit_sha || receipt.commit_sha !== verification.commit_sha
      || !verification.source_revision || receipt.source_revision !== verification.source_revision) {
      throw Object.assign(new Error("Verification evidence no longer matches the recovery assignment."), { code: "VERIFY_SOURCE_STALE" });
    }
    return file;
  }
}
