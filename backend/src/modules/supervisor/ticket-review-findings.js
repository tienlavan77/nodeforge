// Persists Reviewer findings and Coder resolutions across ticket revisions and restarts.
import { ConfigurationError } from "../../shared/errors.js";
import { acquireTicketFileLock } from "./ticket-file-lock.js";

const ROOT = ".forge/runtime/ticket-review-findings";
const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Tracks required findings with stable IDs and verified resolution references.
export function createTicketReviewFindingsStore({ taskId, fileService, executionContexts, gitService } = {}) {
  if (!/^[A-Za-z0-9._:-]+$/.test(taskId ?? "") || !fileService?.readFile || !fileService?.atomicWrite || !executionContexts?.load) throw fail("CONFIGURATION_ERROR", "Finding store requires ticket identity, File Service, and execution context.");
  const path = `${ROOT}/${taskId}.json`;
  return Object.freeze({ load, recordReview, recordResolutions, assertResolved, unresolved });

  // Loads the durable finding history without fabricating a prior verdict.
  async function load() {
    try { return JSON.parse(await fileService.readFile({ path })); }
    catch (error) { if (error.code === "ENOENT") return { task_id: taskId, next_id: 1, findings: [] }; throw error; }
  }

  // Adds or reopens Reviewer findings while preserving IDs from earlier attempts.
  async function recordReview({ verdict, findings, artifactId, commitSha }) {
    if (!["approved", "request_changes"].includes(verdict) || !Array.isArray(findings)) throw fail("REVIEW_FINDINGS_INVALID", "Review verdict or finding list is invalid.");
    return locked(async () => {
      const current = await load();
      const context = await executionContexts.load(taskId);
      if (!context || context.verification_artifact_id !== artifactId || context.review_commit_sha !== commitSha) throw fail("REVIEW_FINDINGS_STALE", "Review findings do not match the verified commit.");
      const next = structuredClone(current);
      if (verdict === "request_changes") for (const message of findings) {
        if (typeof message !== "string" || !message.trim()) throw fail("REVIEW_FINDINGS_INVALID", "Review finding text is required.");
        const prior = next.findings.find((item) => item.message === message.trim() && item.status !== "fixed");
        if (prior) { prior.status = "open"; prior.review_commit_sha = commitSha; prior.artifact_id = artifactId; continue; }
        next.findings.push({ finding_id: `REV-${next.next_id++}`, message: message.trim(), severity: "major", status: "open", changed_paths: [], evidence_refs: [], resolved_revision: null, review_commit_sha: commitSha, artifact_id: artifactId });
      }
      if (verdict === "approved") {
        const unresolved = next.findings.filter((item) => item.severity !== "minor" && item.status !== "fixed");
        if (unresolved.length) throw fail("REVIEW_FINDINGS_UNRESOLVED", `Required Reviewer findings remain unresolved: ${unresolved.map((item) => item.finding_id).join(", ")}.`);
      }
      await save(next);
      return next;
    });
  }

  // Records Coder resolution claims only when they cite current artifact and commit evidence.
  async function recordResolutions(resolutions, artifact) {
    if (!Array.isArray(resolutions)) throw fail("FINDING_RESOLUTION_INVALID", "Finding resolutions must be an array.");
    return locked(async () => {
      const current = await load();
      const context = await executionContexts.load(taskId);
      if (!context || context.verification_artifact_id !== artifact?.artifact_id || context.review_commit_sha !== artifact?.commit_sha || context.source_revision !== artifact?.source_revision) throw fail("FINDING_RESOLUTION_STALE", "Finding resolution evidence is stale.");
      const next = structuredClone(current);
      const seen = new Set();
      for (const resolution of resolutions) {
        const finding = next.findings.find((item) => item.finding_id === resolution?.finding_id);
        if (!finding || seen.has(finding.finding_id) || !["fixed", "not_fixed", "not_applicable"].includes(resolution.status)) throw fail("FINDING_RESOLUTION_INVALID", "Finding resolution ID or status is invalid.");
        seen.add(finding.finding_id);
        const paths = resolution.changed_paths;
        if (!Array.isArray(paths) || paths.some((item) => typeof item !== "string" || !Object.hasOwn(artifact.file_checksums, item))) throw fail("FINDING_RESOLUTION_INVALID", "Finding paths must belong to the verified manifest.");
        if (resolution.status === "fixed" && !paths.length) throw fail("FINDING_RESOLUTION_EVIDENCE", "Fixed findings require changed paths.");
        if (resolution.status === "fixed" && finding.review_commit_sha === artifact.commit_sha) throw fail("FINDING_RESOLUTION_STALE", "A finding cannot be fixed by the commit that created it.");
        if (resolution.status === "fixed" && gitService?.getChangedFiles) {
          const diffPaths = await gitService.getChangedFiles({ baseCommit: finding.review_commit_sha, headCommit: artifact.commit_sha });
          if (paths.some((item) => !diffPaths.includes(item))) throw fail("FINDING_RESOLUTION_EVIDENCE", "Finding path was not changed after the review that raised it.");
        }
        finding.status = resolution.status;
        finding.changed_paths = [...paths];
        finding.evidence_refs = [artifact.artifact_id, artifact.commit_sha];
        finding.resolved_revision = artifact.source_revision;
      }
      await save(next);
      return next;
    });
  }

  // Returns only required findings that still need code or evidence.
  async function unresolved() { return (await load()).findings.filter((item) => item.severity !== "minor" && item.status !== "fixed"); }

  // Blocks terminal acceptance while a required finding lacks a verified resolution.
  async function assertResolved() {
    const pending = await unresolved();
    if (pending.length) throw fail("REVIEW_FINDINGS_UNRESOLVED", `Required Reviewer findings remain unresolved: ${pending.map((item) => item.finding_id).join(", ")}.`);
    return true;
  }

  // Serializes finding state changes across API workers.
  async function locked(action) { const lock = await acquireTicketFileLock(fileService, `${path}.lock`); try { return await action(); } finally { await lock.release(); } }

  // Persists the full finding history through Forge File Service.
  async function save(record) { await fileService.atomicWrite({ path, content: `${JSON.stringify(record)}\n`, replace: true }); }
}
