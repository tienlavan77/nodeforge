// Checks current Reviewer read tools against retained review evidence so historic access failures do not become invented approvals.
import { createHash } from "node:crypto";
import { createCommittedReviewSource } from "../review/reviewer-committed-source.js";
import { assertReviewerReadPath, createReviewerForgeTools } from "../review/reviewer-forge-tools.js";

// Probes the exact earlier review revision without launching Reviewer, changing a verdict or granting write access.
export async function inspectBlockerReviewAccess({ job, workspace, checkpoint, reviewCheckpoint, context }) {
  if (!checkpoint.review_cycle_id || context?.review_repair_cycle_id !== checkpoint.review_cycle_id
    || reviewCheckpoint?.status !== "completed" || reviewCheckpoint.verdict !== "request_changes") return null;
  const artifact = reviewCheckpoint.verification;
  const prior = reviewCheckpoint.execution_context;
  try {
    if (!prior || prior.task_id !== job.request.task_id || prior.project_id !== job.request.project_id
      || artifact?.status !== "passed" || reviewCheckpoint.commit !== artifact.commit_sha
      || prior.review_commit_sha !== artifact.commit_sha || prior.verification_artifact_id !== artifact.artifact_id
      || prior.manifest_sha !== artifact.manifest_sha || prior.source_revision !== artifact.source_revision
      || prior.base_sha !== artifact.base_sha || !Array.isArray(prior.manifest_paths)
      || JSON.stringify([...prior.manifest_paths].sort()) !== JSON.stringify(Object.keys(artifact.file_checksums ?? {}).sort()))
      throw Object.assign(new Error("Retained review access identity is incomplete or stale."), { code: "REVIEW_EVIDENCE_MISMATCH" });
    const root = workspace.path ?? workspace.projectRoot;
    const source = createCommittedReviewSource({ projectRoot: root, commit: artifact.commit_sha, baseCommit: artifact.base_sha });
    const files = [];
    for (const [path, expected] of Object.entries(artifact.file_checksums)) {
      let file;
      try { file = await source.readForIndex({ path }); }
      catch (error) { if (error.code !== "ENOENT" || expected !== null) throw error; }
      if ((file?.sha256 ?? null) !== expected) throw Object.assign(new Error(`Review checksum mismatch: ${path}.`), { code: "REVIEW_SOURCE_MISMATCH" });
      files.push({ path, sha256: expected, content: file?.content ?? null, deleted: !file });
    }
    const tools = createReviewerForgeTools({ fileService: source, projectRoot: root, job: job.request,
      reviewer: { agent_id: "NODE-REVIEW-ACCESS-CHECK", role: "reviewer" }, ticketEvidence: { artifact, context: prior, files, paths: prior.manifest_paths } });
    for (const file of files) if (!file.deleted) await tools.registry.read_lines.execute({ path: file.path, start_line: 1, end_line: 1 });
    // Project instructions use the reviewed commit; role rules are supplied separately by Node for each review invocation.
    let instructions = "absent_in_reviewed_commit";
    try { await tools.registry.read_file.execute({ path: "AGENTS.md" }); instructions = "readable"; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await assertReviewerReadPath(root, "workflows/agents/reviewer/README.md");
    const rules = await workspace.fileService.readForIndex({ path: "workflows/agents/reviewer/README.md", maxBytes: 32000 });
    if (!rules.content?.trim()) throw Object.assign(new Error("Reviewer role rules are unavailable."), { code: "REVIEWER_RULES_UNAVAILABLE" });
    const evidence = { status: "verified", project_id: job.request.project_id, task_id: job.request.task_id,
      repair_cycle_id: checkpoint.review_cycle_id, artifact_id: artifact.artifact_id, commit_sha: artifact.commit_sha,
      manifest_sha: artifact.manifest_sha, file_checksums: artifact.file_checksums, instructions,
      role_rules_sha256: createHash("sha256").update(rules.content).digest("hex"),
      verdict: "unchanged", permissions: "project_read_only" };
    return { ...evidence, sha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") };
  } catch (error) {
    return { status: "blocked", code: error.code ?? "REVIEW_ACCESS_FAILED", message: error.message,
      artifact_id: artifact?.artifact_id ?? null, verdict: "unchanged" };
  }
}
