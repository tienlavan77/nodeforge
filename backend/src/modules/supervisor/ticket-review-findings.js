// Persists Reviewer findings and Coder resolutions across ticket revisions and restarts.
import { ConfigurationError } from "../../shared/errors.js";
import { acquireTicketFileLock } from "./ticket-file-lock.js";

const ROOT = ".forge/runtime/ticket-review-findings";
const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Tracks required findings with stable IDs and verified resolution references.
export function createTicketReviewFindingsStore({ taskId, fileService, executionContexts, gitService } = {}) {
  if (!/^[A-Za-z0-9._:-]+$/.test(taskId ?? "") || !fileService?.readFile || !fileService?.atomicWrite || !executionContexts?.load) throw fail("CONFIGURATION_ERROR", "Finding store requires ticket identity, File Service, and execution context.");
  const path = `${ROOT}/${taskId}.json`;
  return Object.freeze({ load, recordCoderReportDraft, recordCoderReport, recordResponse, recordReview, recordResolutions, assertResolved, unresolved });

  // Loads the durable finding history without fabricating a prior verdict.
  async function load() {
    try { return JSON.parse(await fileService.readFile({ path })); }
    catch (error) { if (error.code === "ENOENT") return { task_id: taskId, version: 0, next_id: 1, findings: [], coder_reports: [], coder_responses: [], adjudications: [] }; throw error; }
  }

  // Keeps the first Coder report and adds only missing explanation fields for the same verified artifact.
  async function recordCoderReportDraft({ report, artifact }) {
    return locked(async () => {
      const current = await load();
      await assertIdentity(artifact);
      const completed = (current.coder_reports ?? []).find((entry) => entry.artifact_id === artifact.artifact_id);
      const previous = (current.coder_report_drafts ?? []).find((entry) => entry.artifact_id === artifact.artifact_id);
      if (!previous && !completed && !report?.summary?.trim()) throw fail("CODER_REPORT_INVALID", "The first Coder report requires a summary.");
      if (previous && (previous.review_commit_sha !== artifact.commit_sha || previous.source_revision !== artifact.source_revision || previous.manifest_sha !== artifact.manifest_sha)) throw fail("CODER_REPORT_CONFLICT", "Coder report identity changed during supplementation.");
      const original = completed?.report ?? previous?.report ?? {};
      const merged = { ...original };
      for (const [key, value] of Object.entries(report ?? {})) {
        if (value === undefined) continue;
        if ((completed || key === "summary") && Object.hasOwn(original, key) && JSON.stringify(original[key]) !== JSON.stringify(value)) throw fail("CODER_REPORT_CONFLICT", `Coder report field ${key} is already recorded; submit only missing information or a correction to a draft field.`);
        merged[key] = value;
      }
      if (completed || previous && JSON.stringify(previous.report) === JSON.stringify(merged)) return merged;
      const entry = { task_id: taskId, original_report: previous?.original_report ?? previous?.report ?? merged, report: merged, submissions: [...(previous?.submissions ?? []), { fields: Object.keys(report ?? {}), report, submitted_at: new Date().toISOString() }], artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha, source_revision: artifact.source_revision, manifest_sha: artifact.manifest_sha, recorded_at: previous?.recorded_at ?? new Date().toISOString() };
      await save({ ...current, version: (current.version ?? 0) + 1, coder_report_drafts: [...(current.coder_report_drafts ?? []).filter((item) => item.artifact_id !== artifact.artifact_id), entry] });
      return merged;
    });
  }

  // Stores the Coder's explanation against a passed artifact before review.
  async function recordCoderReport({ report, artifact, idempotencyKey }) {
    return locked(async () => {
      const current = await load();
      await assertIdentity(artifact);
      if (!idempotencyKey || !report?.summary) throw fail("CODER_REPORT_INVALID", "Coder explanation requires a summary and idempotency key.");
      const previous = (current.coder_reports ?? []).find((item) => item.idempotency_key === idempotencyKey);
      if (previous) {
        if (previous.artifact_id !== artifact.artifact_id || JSON.stringify(previous.report) !== JSON.stringify(report)) throw fail("CODER_REPORT_CONFLICT", "Coder report key was reused with different evidence.");
        return previous;
      }
      const entry = { idempotency_key: idempotencyKey, task_id: taskId, report, artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha, source_revision: artifact.source_revision, manifest_sha: artifact.manifest_sha, recorded_at: new Date().toISOString() };
      await save({ ...current, version: (current.version ?? 0) + 1, coder_reports: [...(current.coder_reports ?? []), entry] });
      return entry;
    });
  }

  // Stores a Coder's position on open findings without deciding their outcome.
  async function recordResponse({ responses, artifact, actor, idempotencyKey }) {
    return locked(async () => {
      const current = await load();
      await assertIdentity(artifact);
      if (!actor || !idempotencyKey || !Array.isArray(responses) || !responses.length) throw fail("REVIEW_RESPONSE_INVALID", "Coder response needs actor, key and findings.");
      const previous = (current.coder_responses ?? []).find((item) => item.idempotency_key === idempotencyKey);
      if (previous) {
        if (previous.artifact_id !== artifact.artifact_id || JSON.stringify(previous.responses) !== JSON.stringify(responses)) throw fail("REVIEW_RESPONSE_CONFLICT", "Response key was reused with different evidence.");
        return previous;
      }
      const ids = new Set();
      for (const response of responses) {
        if (!current.findings.some((item) => item.finding_id === response.finding_id && !isClosed(current, item)) || ids.has(response.finding_id) || !["accept", "dispute"].includes(response.position) || !response.rationale?.trim() || !Array.isArray(response.files) || !Array.isArray(response.evidence_refs) || !response.evidence_refs.length || response.evidence_refs.some((ref) => !String(ref).trim())) throw fail("REVIEW_RESPONSE_INVALID", "Response must cite one open finding with a position, rationale and evidence.");
        ids.add(response.finding_id);
      }
      const entry = { idempotency_key: idempotencyKey, task_id: taskId, actor, responses, artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha, source_revision: artifact.source_revision, manifest_sha: artifact.manifest_sha, recorded_at: new Date().toISOString() };
      await save({ ...current, version: (current.version ?? 0) + 1, coder_responses: [...(current.coder_responses ?? []), entry] });
      return entry;
    });
  }

  // Rejects a submission against stale or mismatched immutable source.
  async function assertIdentity(artifact) {
    const context = await executionContexts.load(taskId);
    if (!context || !artifact || context.review_commit_sha !== artifact.commit_sha || context.verification_artifact_id !== artifact.artifact_id || context.source_revision !== artifact.source_revision || context.manifest_sha !== artifact.manifest_sha || artifact.status !== "passed") throw fail("REVIEW_EVIDENCE_MISMATCH", "Coder explanation differs from the passed ticket revision.");
    return context;
  }

  // Adds or reopens Reviewer findings while preserving IDs from earlier attempts.
  async function recordReview({ verdict, findings, adjudications = [], artifactId, commitSha, reviewerId, sourceRevision }) {
    if (!["approved", "request_changes"].includes(verdict) || !Array.isArray(findings)) throw fail("REVIEW_FINDINGS_INVALID", "Review verdict or finding list is invalid.");
    return locked(async () => {
      const current = await load();
      const context = await executionContexts.load(taskId);
      if (!context || context.verification_artifact_id !== artifactId || context.review_commit_sha !== commitSha || (sourceRevision && context.source_revision !== sourceRevision)) throw fail("REVIEW_FINDINGS_STALE", "Review findings do not match the verified commit.");
      const next = structuredClone(current);
      next.version = (next.version ?? 0) + 1;
      next.adjudications ??= [];
      const pendingResponses = (next.coder_responses ?? []).flatMap((entry) => entry.responses.map((response) => ({ response, entry }))).filter(({ response, entry }) => !next.adjudications.some((decision) => decision.finding_id === response.finding_id && decision.response_id === entry.idempotency_key));
      if (pendingResponses.some(({ response, entry }) => !adjudications.some((decision) => decision.finding_id === response.finding_id && (decision.response_id === entry.idempotency_key || !decision.response_id)))) throw fail("REVIEW_ADJUDICATION_MISSING", "Reviewer must adjudicate each pending Coder response.");
      if (verdict === "request_changes") for (const finding of findings) {
        const message = typeof finding === "string" ? finding : finding?.failure;
        if (typeof message !== "string" || !message.trim()) throw fail("REVIEW_FINDINGS_INVALID", "Review finding text is required.");
        if (typeof finding === "object" && (!finding.acceptance_criterion?.trim() || !finding.minimum_change_scope?.trim() || !Array.isArray(finding.evidence_refs) || !finding.evidence_refs.length || (Array.isArray(finding.files) && finding.files.length > 1 && (!Array.isArray(finding.per_file_necessity) || finding.per_file_necessity.length !== finding.files.length || finding.per_file_necessity.some((part) => !part?.path?.trim() || !part.role?.trim()))))) throw fail("REVIEW_FINDINGS_INVALID", "Review finding requires criterion, evidence, minimum scope and per-file necessity for multi-file demands.");
        const prior = next.findings.find((item) => item.message === message.trim() && item.status !== "fixed");
        if (prior) { prior.status = "open"; prior.review_commit_sha = commitSha; prior.artifact_id = artifactId; continue; }
        next.findings.push({ finding_id: `REV-${next.next_id++}`, message: message.trim(), ...(typeof finding === "object" ? { finding } : { legacy: true }), severity: "major", status: "open", changed_paths: [], evidence_refs: [], resolved_revision: null, review_commit_sha: commitSha, artifact_id: artifactId });
      }
      for (const decision of adjudications) {
        const target = next.findings.find((item) => item.finding_id === decision.finding_id);
        if (!target || !["retain", "refine", "withdraw", "not_applicable", "fixed"].includes(decision.decision) || !decision.reason?.trim() || !Array.isArray(decision.evidence_refs) || !decision.evidence_refs.length || !reviewerId) throw fail("REVIEW_ADJUDICATION_INVALID", "Reviewer decision needs a known finding, reason and evidence.");
        const entry = { ...decision, reviewer_id: reviewerId, task_id: taskId, review_commit_sha: commitSha, artifact_id: artifactId, source_revision: context.source_revision, recorded_at: new Date().toISOString() };
        const petition = pendingResponses.find(({ response }) => response.finding_id === decision.finding_id);
        if (petition) entry.response_id = petition.entry.idempotency_key;
        if (decision.decision === "fixed" && target.review_commit_sha === commitSha) throw fail("REVIEW_ADJUDICATION_STALE", "A finding cannot be fixed by the commit on which it was raised.");
        if (next.adjudications.some((item) => item.finding_id === entry.finding_id && item.artifact_id === artifactId && item.decision === entry.decision && item.reason === entry.reason)) continue;
        next.adjudications.push(entry);
        if (["withdraw", "not_applicable", "fixed"].includes(decision.decision)) target.status = decision.decision;
        if (decision.decision === "refine") target.refinements = [...(target.refinements ?? []), entry];
      }
      if (verdict === "approved") {
        const unresolved = next.findings.filter((item) => item.severity !== "minor" && !isClosed(next, item));
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
        const decision = { finding_id: resolution.finding_id, decision: resolution.status === "fixed" ? "fixed" : resolution.status === "not_applicable" ? "not_applicable" : "retain", reason: resolution.reason ?? "Coder supplied a resolution claim for independent Reviewer adjudication.", evidence_refs: resolution.evidence_refs ?? [artifact.artifact_id], reviewer_id: null, response_id: null, artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha, source_revision: artifact.source_revision, recorded_at: new Date().toISOString() };
        next.coder_claims = [...(next.coder_claims ?? []), { ...resolution, ...decision }];
      }
      next.version = (next.version ?? 0) + 1;
      await save(next);
      return next;
    });
  }

  // Returns only required findings that still need code or evidence.
  async function unresolved() { const record = await load(); return record.findings.filter((item) => item.severity !== "minor" && !isClosed(record, item)); }

  // Closes a finding only on an independent Reviewer decision in the durable history.
  function isClosed(record, finding) {
    return (record.adjudications ?? []).some((item) => item.finding_id === finding.finding_id && ["fixed", "withdraw", "not_applicable"].includes(item.decision));
  }

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
