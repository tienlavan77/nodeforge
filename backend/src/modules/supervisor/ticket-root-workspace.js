// Binds a new ticket to project-root source, durable ledger, and immutable commit evidence.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { createGitService } from "../../infrastructure/git/git-service.js";
import { createIndexFreshnessChecker } from "../index/index-freshness.js";
import { createRelevantTreeSelector } from "../index/relevant-tree.js";
import { createTicketChangeLedger } from "./ticket-change-ledger.js";
import { createTicketCommitFileService } from "./ticket-commit-file-service.js";
import { createTicketExecutionContextStore } from "./ticket-execution-context.js";
import { createTicketReviewFindingsStore } from "./ticket-review-findings.js";
import { createTicketRootCommitService } from "./ticket-root-commit-service.js";
import { createTicketRootGit } from "./ticket-root-git.js";
import { createTicketVerificationService } from "./ticket-verification-service.js";
import { createCompletionReportService } from "./completion-report-service.js";
import { acquireTicketFileLock } from "./ticket-file-lock.js";
import { createTerminalReceiptWriter } from "./terminal-receipt-writer.js";

const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });
const key = (value) => createHash("sha256").update(value).digest("hex");

// Creates root-bound ticket services while retaining legacy worktrees as historical evidence.
export function createTicketRootWorkspace({ projectRoot, projectId, protocolStorage, stateFileService, receiptWriter, indexDatabase, codeSearch, fileGraph, codeCache, projectLogger = () => {} }) {
  const ledger = createTicketChangeLedger({ fileService: stateFileService, projectId, projectLogger });
  const executionContexts = createTicketExecutionContextStore({ fileService: stateFileService, projectId, projectRoot, projectLogger });
  const git = createGitService({ projectRoot });
  const rootGit = createTicketRootGit({ projectRoot });
  const receipts = receiptWriter ?? createTerminalReceiptWriter({ fileService: stateFileService, projectLogger });
  const statePath = (taskId) => `.forge/runtime/ticket-root-workspaces/${key(projectId)}/${key(taskId)}.json`;
  const opened = new Map();
  const opening = new Map();
  return Object.freeze({ ensure, open, close: () => opened.clear() });

  // Persists the root commit baseline before the Supervisor dispatches a Coder.
  async function ensure(taskId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId ?? "")) throw fail("TICKET_ROOT_ID_INVALID", "Root ticket requires a safe ID.");
    const lock = await acquireTicketFileLock(stateFileService, `${statePath(taskId)}.lock`);
    try { return await ensureLocked(taskId); }
    finally { await lock.release(); }
  }

  // Reuses the same baseline when two Supervisors prepare one ticket concurrently.
  async function ensureLocked(taskId) {
    let state;
    try { state = JSON.parse(await stateFileService.readFile({ path: statePath(taskId) })); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (state) {
      if (state.project_id !== projectId || state.task_id !== taskId || !/^[a-f0-9]{40,64}$/i.test(state.base_commit)) throw fail("TICKET_ROOT_STATE_INVALID", "Persisted root ticket baseline is invalid.");
      if (state.branch !== await git.currentBranch()) throw fail("TICKET_ROOT_BRANCH_CHANGED", "Root ticket branch differs from its persisted baseline.");
      await rootGit.assertAncestor(state.base_commit);
      return { path: projectRoot, branch: state.branch, base_commit: state.base_commit, root_only: true, reused: true };
    }
    const historical = await executionContexts.load(taskId);
    const changes = await ledger.load(taskId);
    const coderCheckpoint = await optionalState(`.forge/runtime/agent-checkpoints/${taskId}.json`);
    const reviewerCheckpoint = await optionalState(`.forge/runtime/reviewer-checkpoints/${taskId}.json`);
    if (historical || coderCheckpoint || reviewerCheckpoint || changes.revision || Object.keys(changes.commits).length) throw fail("TICKET_ROOT_CONTEXT_MIGRATION_REQUIRED", "Existing ticket evidence needs explicit disposition before root-only execution.");
    const branch = await git.currentBranch();
    if (!branch) throw fail("TICKET_ROOT_BRANCH_INVALID", "Root ticket needs a named project branch.");
    const record = { project_id: projectId, task_id: taskId, branch, base_commit: await git.getHead(), root_only: true, created_at: new Date().toISOString() };
    await stateFileService.atomicWrite({ path: statePath(taskId), content: `${JSON.stringify(record)}\n`, replace: false });
    return { path: projectRoot, branch, base_commit: record.base_commit, root_only: true, reused: false };
  }

  // Detects historical checkpoints without modifying or relabeling their evidence.
  async function optionalState(path) {
    try { return await stateFileService.readFile({ path }); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  // Record root integration after verifying the exact reviewed commit is still reachable.
  async function integrateRoot(taskId, identity, testService) {
    const lock = await acquireTicketFileLock(stateFileService, ".forge/runtime/ticket-integrations/integration.lock");
    try {
      const artifact = await testService.assertPassedArtifact();
      const branch = (await rootGit.checkedBranch()).slice("refs/heads/".length);
      if (branch !== identity.branch) throw fail("TICKET_INTEGRATION_CONFLICT", "Project branch changed since the root ticket began.");
      const prior = await receipts.load(taskId);
      if (prior) {
        if (prior.task_id !== taskId || prior.workspace_mode !== "root-only" || prior.branch !== branch || prior.commit !== artifact.commit_sha || prior.reviewed_commit !== artifact.commit_sha || prior.artifact_id !== artifact.artifact_id || prior.tree_sha !== artifact.tree_sha || prior.manifest_sha !== artifact.manifest_sha || prior.source_revision !== artifact.source_revision) throw fail("TICKET_INTEGRATION_CONFLICT", "Root integration receipt differs from the reviewed ticket evidence.");
        await rootGit.assertAncestor(prior.commit);
        if (prior.status === "completed") return { sha: prior.commit, repeated: true };
        if (prior.status !== "prepared") throw fail("TICKET_INTEGRATION_CONFLICT", "Root integration receipt has an unknown phase.");
        await receipts.saveCompleted(taskId, prior);
        return { sha: prior.commit, recovered: true };
      }
      const commit = artifact.commit_sha;
      // Root-only commits are on HEAD before integration; previous_head is HEAD at receipt time.
      const state = { task_id: taskId, branch, previous_head: (await git.getHead()).trim(), reviewed_commit: commit, commit, artifact_id: artifact.artifact_id, tree_sha: artifact.tree_sha, manifest_sha: artifact.manifest_sha, source_revision: artifact.source_revision, base_sha: artifact.base_sha,
        workspace_mode: "root-only", supervisor_id: null, recorded_at: new Date().toISOString() };
      await receipts.savePrepared(taskId, state);
      await rootGit.assertAncestor(commit);
      await receipts.saveCompleted(taskId, state);
      projectLogger({ event_name: "ticket.integration_completed", level: "info", status: "success", message: "Reviewed root ticket commit recorded as integrated.", task_id: taskId, source: "ticket-root-workspace", payload: { commit, previous_head: state.previous_head } });
      return { sha: commit };
    } finally { await lock.release(); }
  }

  // Opens Coder tools on the live root and Reviewer tools on its recorded commit.
  async function open(taskId) {
    if (opened.has(taskId)) return opened.get(taskId);
    if (opening.has(taskId)) return opening.get(taskId);
    const pending = openOnce(taskId);
    opening.set(taskId, pending);
    try { return await pending; }
    finally { opening.delete(taskId); }
  }

  // Constructs one workspace after the root baseline has been persisted.
  async function openOnce(taskId) {
    const identity = await ensure(taskId);
    const committedFiles = createTicketCommitFileService({ taskId, projectRoot, executionContexts });
    const rootGit = createTicketRootCommitService({ taskId, projectId, projectRoot, fileService: stateFileService, ledger, gitService: git, expectedBranch: identity.branch, projectLogger });
    const changeLedger = { write: async (change) => { await executionContexts.assertApprovedPath(taskId, change.path); return ledger.write({ ...change, taskId }); }, snapshot: () => ledger.snapshot(taskId), release: () => ledger.release(taskId) };
    const freshnessChecker = createIndexFreshnessChecker({ database: indexDatabase, fileService: stateFileService });
    const relevantTreeSelector = createRelevantTreeSelector({ search: codeSearch, fileGraph, freshnessChecker });
    const testService = createTicketVerificationService({ taskId, projectId, projectRoot, worktreeRoot: projectRoot, worktreeFileService: stateFileService, stateFileService, gitService: rootGit, ledger, executionContexts, rootOnly: true, projectLogger });
    const reviewFindings = createTicketReviewFindingsStore({ taskId, fileService: stateFileService, executionContexts, gitService: rootGit });
    const reportService = createCompletionReportService({ protocolStorage, fileService: stateFileService, gitService: rootGit });
    const workspace = Object.freeze({ ...identity, projectRoot, migrationRequired: false, fileService: stateFileService, worktreeFileService: committedFiles, gitService: rootGit, worktreeGitService: rootGit, changeLedger, executionContexts, reviewFindings, codeSearch, codeCache, relevantTreeSelector, freshnessChecker, testService, reportService,
      integrate: () => integrateRoot(taskId, identity, testService) });
    opened.set(taskId, workspace);
    return workspace;
  }
}
