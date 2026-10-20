// Starts a fresh repair journal while preserving integrated code and all previous ticket evidence.
import { createHash } from "node:crypto";
import { acquireTicketFileLock } from "./ticket-file-lock.js";
import { withTicketProjectCommitLock } from "./ticket-project-commit-lock.js";
import { loadFindingReviewSource } from "./finding-review-repair-workspace.js";

// Maps project and ticket identities to the existing private runtime paths.
const key = (value) => createHash("sha256").update(value).digest("hex");

// Archives a completed cycle and prepares only the next finding-driven repair, with restart recovery.
export async function prepareCompletedReviewRepair({ taskId, projectId, fileService, executionContexts, ledger, binding, cycleId }) {
  const scope = key(projectId);
  const manifestPath = `.forge/runtime/ticket-changes/${scope}/tickets/${key(taskId)}.json`;
  const contextPath = `.forge/runtime/ticket-execution-contexts/${scope}/${taskId}.json`;
  const integrationPath = `.forge/runtime/ticket-integrations/${taskId}.json`;
  const receiptPath = `.forge/runtime/ticket-review-repairs/${scope}/${taskId}/${cycleId}.json`;
  return withTicketProjectCommitLock({ fileService, projectId }, async () => {
    const contextLock = await acquireTicketFileLock(fileService, `${contextPath}.lock`);
    try {
      const ledgerLock = await acquireTicketFileLock(fileService, `.forge/runtime/ticket-changes/${scope}/locks/${key(`ticket:${taskId}`)}.lock`);
      try {
        let receipt = await readOptional(receiptPath);
        const context = await executionContexts.load(taskId);
        const manifest = await ledger.load(taskId);
        if (!receipt) {
          if (context?.state !== "terminal" || context.review_commit_sha !== binding.commit || context.verification_artifact_id !== binding.artifact_id
            || manifest.state !== "closed" || manifest.pending_commit || Object.values(manifest.entries).some((entry) => entry.pending)) throw failure("REVIEW_REPAIR_SOURCE_CONFLICT", "Repair requires the exact settled integrated cycle.");
          const integration = await readOptional(integrationPath);
          if (integration?.status !== "completed" || integration.commit !== binding.commit || integration.artifact_id !== binding.artifact_id) throw failure("REVIEW_REPAIR_SOURCE_CONFLICT", "Completed integration receipt differs from review.");
          receipt = { task_id: taskId, project_id: projectId, cycle_id: cycleId, binding, phase: "prepared", context, manifest, integration, created_at: new Date().toISOString() };
          await fileService.atomicWrite({ path: receiptPath, content: JSON.stringify(receipt), replace: false });
        }
        if (receipt.task_id !== taskId || receipt.project_id !== projectId || receipt.binding.commit !== binding.commit || receipt.binding.artifact_id !== binding.artifact_id) throw failure("REVIEW_REPAIR_SOURCE_CONFLICT", "Repair receipt does not match Owner review evidence.");
        if (receipt.phase === "ready") {
          if (context?.review_repair_cycle_id !== cycleId || manifest.review_repair_cycle_id !== cycleId) throw failure("REVIEW_REPAIR_SOURCE_CONFLICT", "Prepared repair journal is no longer current.");
          return { cycle_id: cycleId, receipt: receiptPath };
        }
        if (context?.review_repair_cycle_id !== cycleId && JSON.stringify(context) !== JSON.stringify(receipt.context)
          || manifest.review_repair_cycle_id !== cycleId && JSON.stringify(manifest) !== JSON.stringify(receipt.manifest)) throw failure("REVIEW_REPAIR_SOURCE_CONFLICT", "Ticket changed during repair preparation.");
        const nextManifest = { project_id: projectId, task_id: taskId, state: "active", revision: receipt.manifest.revision + 1,
          entries: {}, commits: {}, pending_commit: null, review_repair_cycle_id: cycleId };
        const nextContext = { ...receipt.context, ...executionContexts.manifestIdentity(nextManifest), state: "coding", verification_artifact_id: null,
          review_commit_sha: null, source_repair_cycle_id: null, review_repair_cycle_id: cycleId, version: receipt.context.version + 1, updated_at: new Date().toISOString() };
        await fileService.atomicWrite({ path: manifestPath, content: JSON.stringify(nextManifest), replace: true });
        await fileService.atomicWrite({ path: contextPath, content: JSON.stringify(nextContext), replace: true });
        const integration = await readOptional(integrationPath);
        if (integration) {
          if (JSON.stringify(integration) !== JSON.stringify(receipt.integration)) throw failure("REVIEW_REPAIR_SOURCE_CONFLICT", "Integration changed during repair preparation.");
          await fileService.deleteFile({ path: integrationPath });
        }
        await fileService.atomicWrite({ path: receiptPath, content: JSON.stringify({ ...receipt, phase: "ready", prepared_at: new Date().toISOString() }), replace: true });
        return { cycle_id: cycleId, receipt: receiptPath };
      } finally { await ledgerLock.release(); }
    } finally { await contextLock.release(); }
  });

  // Reads only Node-owned repair evidence, preserving malformed or unavailable data as errors.
  async function readOptional(path) {
    try { return JSON.parse(await fileService.readFile({ path })); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
}

// Loads archived ticket journals for contract provenance without adding historical files to a new commit.
export async function loadCompletedReviewSource({ taskId, projectId, fileService, executionContexts, context }) {
  const manifests = [];
  const seen = new Set();
  while (context?.review_repair_cycle_id || context?.source_repair_cycle_id) {
    if (context.source_repair_cycle_id) {
      const key = `source:${context.source_repair_cycle_id}`;
      if (seen.has(key)) throw failure("TICKET_CONTRACT_SOURCE_CONFLICT", "Invalid repair source lineage.");
      seen.add(key);
      const receipt = await loadFindingReviewSource({ taskId, projectId, fileService, executionContexts, context });
      manifests.unshift(receipt.manifest);
      context = receipt.context;
      continue;
    }
    const cycleId = context.review_repair_cycle_id;
    if (!/^[A-Za-z0-9-]+$/.test(cycleId) || seen.has(cycleId)) throw failure("TICKET_CONTRACT_SOURCE_CONFLICT", "Invalid repair source lineage.");
    seen.add(cycleId);
    const path = `.forge/runtime/ticket-review-repairs/${key(projectId)}/${taskId}/${cycleId}.json`;
    const receipt = JSON.parse(await fileService.readFile({ path }));
    const identity = executionContexts.manifestIdentity(receipt.manifest);
    if (receipt.phase !== "ready" || receipt.task_id !== taskId || receipt.project_id !== projectId || receipt.cycle_id !== cycleId
      || receipt.context?.task_id !== taskId || receipt.context.project_id !== projectId || receipt.context.base_sha !== context.base_sha
      || receipt.context.state !== "terminal" || receipt.manifest.task_id !== taskId || receipt.manifest.project_id !== projectId
      || receipt.manifest.state !== "closed" || receipt.manifest.pending_commit
      || identity.manifest_sha !== receipt.context.manifest_sha || identity.source_revision !== receipt.context.source_revision
      || receipt.integration?.status !== "completed" || receipt.integration.commit !== receipt.binding.commit
      || receipt.context.review_commit_sha !== receipt.binding.commit || receipt.context.verification_artifact_id !== receipt.binding.artifact_id
      || receipt.integration.artifact_id !== receipt.binding.artifact_id) throw failure("TICKET_CONTRACT_SOURCE_CONFLICT", "Archived repair source differs from integrated evidence.");
    manifests.unshift(receipt.manifest);
    context = receipt.context;
  }
  return manifests;
}

// Exposes source conflicts without authorizing a new policy, file scope or production acceptance.
function failure(code, message) { return Object.assign(new Error(message), { code, statusCode: 409 }); }
