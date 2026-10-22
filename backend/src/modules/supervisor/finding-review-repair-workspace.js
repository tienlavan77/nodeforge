// Starts a finding repair with a fresh write journal while retaining the previously verified source as immutable history.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { acquireTicketFileLock } from "./ticket-file-lock.js";
import { withTicketProjectCommitLock } from "./ticket-project-commit-lock.js";

// Maps durable project and ticket records to their existing private runtime paths.
const key = (value) => createHash("sha256").update(value).digest("hex");
// Reports a scoped conflict without adopting foreign source or granting approval.
const fail = () => Object.assign(new Error("Finding repair does not match its retained verified source."), { code: "REVIEW_REPAIR_SOURCE_CONFLICT" });

// Archives a settled Coder journal before a new finding repair, without reclaiming its historical file set.
export async function prepareFindingReviewRepair({ taskId, projectId, fileService, executionContexts, ledger, testService, reviewKey }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(reviewKey ?? "")) throw fail();
  const scope = key(projectId), cycleId = reviewKey.slice(7);
  const receiptPath = `.forge/runtime/ticket-finding-repairs/${scope}/${taskId}/${cycleId}.json`;
  const manifestPath = `.forge/runtime/ticket-changes/${scope}/tickets/${key(taskId)}.json`;
  const contextPath = `.forge/runtime/ticket-execution-contexts/${scope}/${taskId}.json`;
  return withTicketProjectCommitLock({ fileService, projectId }, async () => {
    let receipt = await readOptional(fileService, receiptPath);
    if (!receipt) {
      const context = await executionContexts.load(taskId);
      if (!context || !["verified", "reviewing"].includes(context.state)) throw fail();
      const artifact = await testService.assertPassedArtifact();
      if (artifact.status !== "passed" || context.verification_artifact_id !== artifact.artifact_id || context.review_commit_sha !== artifact.commit_sha) throw fail();
      // Release old ownership before rotating the journal; its bytes and committed authorship remain archived.
      await ledger.release(taskId, { close: false });
      const manifest = await ledger.load(taskId);
      assertSource({ taskId, projectId, context, manifest, artifact, executionContexts });
      receipt = { task_id: taskId, project_id: projectId, cycle_id: cycleId, review_key: reviewKey, context, manifest, artifact, created_at: new Date().toISOString() };
    }
    const contextLock = await acquireTicketFileLock(fileService, `${contextPath}.lock`);
    try {
      const ledgerLock = await acquireTicketFileLock(fileService, `.forge/runtime/ticket-changes/${scope}/locks/${key(`ticket:${taskId}`)}.lock`);
      try {
        const persisted = await readOptional(fileService, receiptPath);
        if (persisted) receipt = persisted;
        if (receipt.task_id !== taskId || receipt.project_id !== projectId || receipt.cycle_id !== cycleId || receipt.review_key !== reviewKey) throw fail();
        assertSource({ ...receipt, taskId, projectId, executionContexts });
        const currentContext = await executionContexts.load(taskId), currentManifest = await ledger.load(taskId);
        if (persisted && currentContext?.version > receipt.context.version && matchesResumedContext(currentContext, receipt.context, cycleId) && ["verified", "reviewing"].includes(currentContext.state)
          && currentContext.review_commit_sha === receipt.context.review_commit_sha && currentContext.verification_artifact_id === receipt.artifact.artifact_id
          && isDeepStrictEqual(currentManifest, receipt.manifest)) {
          await testService.assertPassedArtifact();
          return { cycle_id: cycleId, receipt: receiptPath, unchanged_source: true };
        }
        if (currentContext?.source_repair_cycle_id === cycleId && currentManifest.source_repair_cycle_id === cycleId) return { cycle_id: cycleId, receipt: receiptPath };
        const nextManifest = { project_id: projectId, task_id: taskId, state: "active", revision: receipt.manifest.revision + 1,
          entries: {}, commits: {}, pending_commit: null, source_repair_cycle_id: cycleId };
        const nextContext = { ...receipt.context, ...executionContexts.manifestIdentity(nextManifest), state: "coding", verification_artifact_id: null,
          review_commit_sha: null, verification_source: null, source_repair_cycle_id: cycleId, version: receipt.context.version + 1, updated_at: receipt.created_at };
        if (![receipt.context, nextContext].some((expected) => isDeepStrictEqual(currentContext, expected))
          || ![receipt.manifest, nextManifest].some((expected) => isDeepStrictEqual(currentManifest, expected))) throw fail();
        if (!persisted) await fileService.atomicWrite({ path: receiptPath, content: JSON.stringify(receipt), replace: false });
        await fileService.atomicWrite({ path: manifestPath, content: JSON.stringify(nextManifest), replace: true });
        await fileService.atomicWrite({ path: contextPath, content: JSON.stringify(nextContext), replace: true });
        return { cycle_id: cycleId, receipt: receiptPath };
      } finally { await ledgerLock.release(); }
    } finally { await contextLock.release(); }
  });
}

// Recognizes unchanged verified source restored by current or earlier Node versions without resetting its journal again.
function matchesResumedContext(current, archived, cycleId) {
  if (!current || current.resumed_finding_cycle_id && current.resumed_finding_cycle_id !== cycleId) return false;
  const actual = { ...current, version: archived.version, updated_at: archived.updated_at };
  const expected = { ...archived, version: archived.version, updated_at: archived.updated_at };
  delete actual.resumed_finding_cycle_id; delete expected.resumed_finding_cycle_id;
  return isDeepStrictEqual(actual, expected);
}

// Loads one archived finding cycle so later contract checks retain the original write provenance.
export async function loadFindingReviewSource({ taskId, projectId, fileService, executionContexts, context }) {
  const cycleId = context?.source_repair_cycle_id;
  if (!/^[a-f0-9]{64}$/.test(cycleId ?? "")) throw fail();
  const receipt = await readOptional(fileService, `.forge/runtime/ticket-finding-repairs/${key(projectId)}/${taskId}/${cycleId}.json`);
  if (!receipt || receipt.task_id !== taskId || receipt.project_id !== projectId || receipt.cycle_id !== cycleId || receipt.review_key !== `sha256:${cycleId}`) throw fail();
  assertSource({ ...receipt, taskId, projectId, executionContexts });
  if (context.base_sha !== receipt.context.base_sha || context.supervisor_id !== receipt.context.supervisor_id) throw fail();
  return receipt;
}

// Proves the archived cycle was committed and passed before separating its historical files from new writes.
function assertSource({ taskId, projectId, context, manifest, artifact, executionContexts }) {
  const identity = executionContexts.manifestIdentity(manifest);
  if (context?.task_id !== taskId || context.project_id !== projectId || manifest.task_id !== taskId || manifest.project_id !== projectId
    || !["verified", "reviewing"].includes(context.state) || manifest.pending_commit || Object.values(manifest.entries).some((entry) => entry.pending)
    || !isDeepStrictEqual(identity.manifest_paths, context.manifest_paths) || identity.source_revision !== context.source_revision || identity.manifest_sha !== context.manifest_sha
    || artifact?.status !== "passed" || artifact.artifact_id !== context.verification_artifact_id || artifact.commit_sha !== context.review_commit_sha
    || artifact.source_revision !== context.source_revision || artifact.manifest_sha !== context.manifest_sha || artifact.base_sha !== context.base_sha
    || manifest.commits[manifest.revision] !== context.review_commit_sha) throw fail();
}

// Reads optional durable evidence without masking corrupt files or filesystem failures.
async function readOptional(fileService, path) {
  try { return JSON.parse(await fileService.readFile({ path })); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
