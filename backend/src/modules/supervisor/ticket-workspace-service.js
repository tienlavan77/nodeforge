// Gives each ticket an isolated Git worktree and Forge code services while keeping Supervisor state central.
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";
import { createFileService } from "../../infrastructure/filesystem/file-service.js";
import { createGitService } from "../../infrastructure/git/git-service.js";
import { createIndexFreshnessChecker } from "../index/index-freshness.js";
import { createRelevantTreeSelector } from "../index/relevant-tree.js";
import { createCodeCacheService } from "../context/code-cache-service.js";
import { createTicketVerificationService } from "./ticket-verification-service.js";
import { createCompletionReportService } from "./completion-report-service.js";
import { createTicketChangeLedger } from "./ticket-change-ledger.js";
import { createTicketCommitService } from "./ticket-commit-service.js";
import { createTicketIntegrationService } from "./ticket-integration-service.js";
import { createTicketExecutionContextStore } from "./ticket-execution-context.js";
import { createTicketReviewFindingsStore } from "./ticket-review-findings.js";
import { migrateLegacyTicket } from "./ticket-legacy-migration.js";
import { createTicketRootWorkspace } from "./ticket-root-workspace.js";
import { createTerminalReceiptWriter } from "./terminal-receipt-writer.js";

const execFile = promisify(execFileCallback);
const SAFE_TASK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Creates or restores one ticket checkout without switching the Control API checkout.
export function createTicketWorkspaceService({ projectRoot, projectId, protocolStorage, stateFileService, indexDatabase, codeSearch, fileGraph, codeCache: sharedCodeCache, rootOnly = false, projectLogger = () => {} } = {}) {
  if (!projectRoot || !projectId || !protocolStorage || !stateFileService || !indexDatabase?.all || !codeSearch?.search || !fileGraph?.getDependencies) throw new ConfigurationError("Ticket workspace requires project services and the existing Code Index.");
  const root = resolve(projectRoot);
  const directory = join(root, ".forge", "worktrees", "tickets");
  const ledger = createTicketChangeLedger({ fileService: stateFileService, projectId, projectLogger });
  const executionContexts = createTicketExecutionContextStore({ fileService: stateFileService, projectId, projectRoot: root, projectLogger });
  const receiptWriter = createTerminalReceiptWriter({ fileService: stateFileService, projectLogger });
  const integration = createTicketIntegrationService({ projectRoot: root, fileService: stateFileService, receiptWriter, requireReviewedCommit: true, projectLogger });
  const sharedCache = sharedCodeCache ?? createCodeCacheService({ projectId, fileService: stateFileService, codeSearch, logger: projectLogger });
  const rootWorkspace = rootOnly ? createTicketRootWorkspace({ projectRoot: root, projectId, protocolStorage, stateFileService, receiptWriter, indexDatabase, codeSearch, fileGraph, codeCache: sharedCache, projectLogger }) : null;
  const opened = new Map();
  const pending = new Map();
  let closed = false;
  return Object.freeze({ ensure, open, migrateLegacy, close });

  // Explicitly imports a verified pre-ledger ticket before it may resume.
  async function migrateLegacy(taskId) {
    const worktree = await ensure(taskId);
    const result = await migrateLegacyTicket({ taskId, worktree: worktree.path, baseCommit: worktree.base_commit, rootFileService: stateFileService, worktreeFileService: createFileService({ projectRoot: worktree.path }), ledger, projectLogger });
    opened.delete(taskId);
    return result;
  }

  // Reuses the ticket branch and checkout after retry or API restart.
  async function ensure(taskId) {
    if (!SAFE_TASK.test(taskId ?? "")) throw new ConfigurationError("Ticket worktree requires a safe task ID.");
    if (rootWorkspace) {
      if (await exists(join(directory, taskId))) throw workspaceError("TICKET_LEGACY_WORKTREE_REQUIRES_DISPOSITION", "Historical ticket worktree requires explicit disposition before root-only execution.");
      return rootWorkspace.ensure(taskId);
    }
    const path = join(directory, taskId);
    const branch = `task/${taskId}`;
    await mkdir(directory, { recursive: true });
    let existing = false;
    try { existing = (await git(["-C", path, "rev-parse", "--show-toplevel"])).trim() === path; }
    catch (error) { if (await exists(path)) throw workspaceError("WORKTREE_PATH_OCCUPIED", `Ticket path is not a Git worktree: ${path}`, error); }
    if (existing) {
      const current = (await git(["-C", path, "branch", "--show-current"])).trim();
      if (current !== branch) throw workspaceError("WORKTREE_BRANCH_MISMATCH", `Ticket worktree has branch ${current}, expected ${branch}.`);
      return { path, branch, base_commit: await baseCommit(taskId, path), reused: true };
    }
    const branchExists = await gitStatus(["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (branchExists === 0) await git(["-C", root, "worktree", "add", path, branch]);
    else if (branchExists === 1) await git(["-C", root, "worktree", "add", "-b", branch, path, "HEAD"]);
    else throw workspaceError("WORKTREE_BRANCH_CHECK_FAILED", `Could not inspect branch ${branch}.`);
    projectLogger({ event_name: "ticket.worktree_created", level: "info", status: "success", message: "Ticket worktree created.", task_id: taskId, source: "ticket-workspace-service", payload: { branch, path } });
    return { path, branch, base_commit: await baseCommit(taskId, path), reused: false };
  }

  // Opens ticket-bound code services against the existing project index without rebuilding it.
  async function open(taskId) {
    if (closed) throw new ConfigurationError("Ticket workspace service is closed.");
    if (rootWorkspace) { await ensure(taskId); return rootWorkspace.open(taskId); }
    if (opened.has(taskId)) return opened.get(taskId);
    if (pending.has(taskId)) return pending.get(taskId);
    const creation = create(taskId);
    pending.set(taskId, creation);
    try { const workspace = await creation; opened.set(taskId, workspace); return workspace; }
    catch (error) { projectLogger({ event_name: "ticket.worktree_open_failed", level: "error", status: "failed", message: "Ticket worktree could not be opened.", task_id: taskId, source: "ticket-workspace-service", error_code: error.code ?? "WORKTREE_OPEN_FAILED", payload: { error: error.message } }); throw error; }
    finally { pending.delete(taskId); }
  }

  async function create(taskId) {
    const worktree = await ensure(taskId);
    await linkDependencies(worktree.path);
    const fileService = stateFileService;
    const worktreeFileService = createFileService({ projectRoot: worktree.path });
    const codeCache = sharedCache;
    const freshnessChecker = createIndexFreshnessChecker({ database: indexDatabase, fileService });
    const relevantTreeSelector = createRelevantTreeSelector({ search: codeSearch, fileGraph, freshnessChecker });
    const worktreeGitService = createGitService({ projectRoot: worktree.path });
    const existingChanges = await ledger.load(taskId);
    const workspaceHead = await worktreeGitService.getHead();
    const dirtyPaths = (await worktreeGitService.status()).split("\n").filter(Boolean).map((line) => line.slice(3).replace(/^"|"$/g, ""));
    const foreignDirty = dirtyPaths.some((path) => !["node_modules", "backend/node_modules", "ui/nextjs/node_modules"].includes(path) && !existingChanges.entries[path]);
    const migrationRequired = foreignDirty || workspaceHead !== worktree.base_commit && !Object.keys(existingChanges.commits).length && !existingChanges.pending_commit;
    const changeLedger = { write: (change) => ledger.write({ ...change, taskId }), snapshot: () => ledger.snapshot(taskId), release: () => ledger.release(taskId) };
    const gitService = createTicketCommitService({ taskId, ledger, worktreeFileService, gitService: worktreeGitService, projectRoot: worktree.path });
    const testService = createTicketVerificationService({ taskId, projectId, projectRoot: root, worktreeRoot: worktree.path, worktreeFileService, stateFileService, gitService: worktreeGitService, ledger, executionContexts, projectLogger });
    const reviewFindings = createTicketReviewFindingsStore({ taskId, fileService: stateFileService, executionContexts, gitService: worktreeGitService });
    const reportService = createCompletionReportService({ protocolStorage, fileService: stateFileService, gitService });
    return Object.freeze({ ...worktree, projectRoot: root, migrationRequired, fileService, worktreeFileService, gitService, worktreeGitService, changeLedger, executionContexts, reviewFindings, integrate: () => integration.integrate({ taskId, worktree: worktree.path, ledger }), codeSearch, codeCache, relevantTreeSelector, freshnessChecker, testService, reportService });
  }

  // Makes existing package installs available without copying or indexing dependency directories.
  async function linkDependencies(path) {
    for (const relativePath of ["node_modules", "backend/node_modules", "ui/nextjs/node_modules"]) {
      const source = join(root, relativePath);
      if (!(await exists(source))) continue;
      const target = join(path, relativePath);
      await mkdir(dirname(target), { recursive: true });
      try { await symlink(source, target, "dir"); }
      catch (error) {
        if (error.code !== "EEXIST" || (await readlink(target)) !== source) throw error;
      }
    }
  }

  // Keeps the review baseline stable when the Control API restarts or the main branch advances.
  async function baseCommit(taskId, path) {
    const statePath = `.forge/runtime/ticket-workspaces/${taskId}.json`;
    try {
      const state = JSON.parse(await stateFileService.readFile({ path: statePath }));
      if (state.path !== path || !/^[a-f0-9]{40,64}$/i.test(state.base_commit)) throw workspaceError("WORKTREE_STATE_INVALID", "Ticket workspace state does not match its worktree.");
      return state.base_commit;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const base = (await git(["-C", path, "merge-base", "HEAD", (await git(["-C", root, "rev-parse", "HEAD"])).trim()])).trim();
    await stateFileService.atomicWrite({ path: statePath, content: `${JSON.stringify({ task_id: taskId, path, base_commit: base })}\n`, replace: true });
    return base;
  }

  // Releases ticket-local cache and SQLite handles when the Control API stops.
  async function close() {
    if (closed) return;
    closed = true;
    await Promise.all([...pending.values()]);
    if (!sharedCodeCache) sharedCache.close();
    rootWorkspace?.close();
    opened.clear();
  }
}

// Runs Git without a shell and preserves the underlying failure for ticket diagnostics.
async function git(args) { try { return (await execFile("git", args, { maxBuffer: 4 * 1024 * 1024 })).stdout; } catch (error) { throw workspaceError("WORKTREE_GIT_FAILED", `Git worktree command failed: ${args.slice(0, 3).join(" ")}.`, error); } }

// Reads Git's exit status for idempotent branch lookup.
async function gitStatus(args) { try { await execFile("git", args); return 0; } catch (error) { return typeof error.code === "number" ? error.code : 2; } }

// Checks for an occupied worktree path without following symlinks.
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }

// Attaches a stable error code to workspace failures.
function workspaceError(code, message, cause) { return Object.assign(new ConfigurationError(message, { cause }), { code }); }
