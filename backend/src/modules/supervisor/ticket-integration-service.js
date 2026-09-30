// Advances the project branch after approved ticket review without replacing live root files.
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { ConfigurationError } from "../../shared/errors.js";
import { acquireTicketFileLock } from "./ticket-file-lock.js";
import { createTerminalReceiptWriter } from "./terminal-receipt-writer.js";

const execFile = promisify(execFileCallback);
const STATE = ".forge/runtime/ticket-integrations";
// Labels branch integration conflicts for the Supervisor outcome.
const failure = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Creates a serialized Git integration gate shared by ticket worktrees.
export function createTicketIntegrationService({ projectRoot, fileService, receiptWriter, requireReviewedCommit = false, projectLogger = () => {} } = {}) {
  if (!projectRoot || !fileService?.createLock) throw failure("CONFIGURATION_ERROR", "Ticket integration requires root Git and File Service.");
  const receipts = receiptWriter ?? createTerminalReceiptWriter({ fileService, projectLogger });
  // Reads normalized Git metadata for branch ancestry checks.
  const git = async (cwd, args) => (await execFile("git", ["-C", cwd, ...args], { maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  // Reads exact committed bytes for source equivalence checks.
  const gitRaw = async (cwd, args) => (await execFile("git", ["-C", cwd, ...args], { maxBuffer: 4 * 1024 * 1024 })).stdout;
  // Makes the reviewed ticket commit the root branch HEAD only when root bytes already match it.
  async function integrate({ taskId, worktree, ledger }) {
    const lock = await acquireTicketFileLock(fileService, `${STATE}/integration.lock`);
    try {
      const manifest = await ledger.snapshot(taskId);
      const paths = Object.keys(manifest.entries);
      const reviewed = manifest.commits[manifest.revision];
      if (!paths.length || !reviewed) throw failure("TICKET_COMMIT_MISSING", "Approved ticket has no matching committed ledger revision.");
      const rootHead = await git(projectRoot, ["rev-parse", "HEAD"]);
      const branch = await git(projectRoot, ["branch", "--show-current"]);
      if (!branch) throw failure("TICKET_INTEGRATION_CONFLICT", "Project root has no checked-out branch.");
      const previous = await receipts.load(taskId);
      if (previous?.workspace_mode === "root-only") throw failure("TICKET_INTEGRATION_CONFLICT", "Root-only receipt cannot be reused for worktree integration.");
      if (previous?.branch && previous.branch !== branch) throw failure("TICKET_INTEGRATION_CONFLICT", "Project branch changed since the ticket integration began.");
      if (previous?.status === "completed") {
        try { await git(projectRoot, ["merge-base", "--is-ancestor", previous.commit, rootHead]); return { sha: previous.commit, repeated: true }; }
        catch (error) { if (error.code !== 1) throw error; }
      }
      if (previous?.status === "prepared" && previous.commit === rootHead) {
        await git(projectRoot, ["read-tree", rootHead]);
        await receipts.saveCompleted(taskId, previous);
        return { sha: rootHead, recovered: true };
      }
      const staged = await git(projectRoot, ["diff", "--cached", "--name-only"]);
      if (staged) throw failure("TICKET_INTEGRATION_CONFLICT", "Project root has staged changes outside the integration transaction.");
      let commit = reviewed;
      if (await git(worktree, ["rev-parse", "HEAD"]) !== reviewed) throw failure("TICKET_INTEGRATION_CONFLICT", "Ticket worktree moved after the reviewed commit.");
      let rootIsAncestor = false;
      try { await git(worktree, ["merge-base", "--is-ancestor", rootHead, commit]); rootIsAncestor = true; }
      catch (error) { if (error.code !== 1) throw error; }
      if (!rootIsAncestor && requireReviewedCommit) throw failure("TICKET_REVALIDATION_REQUIRED", "Project HEAD advanced after ticket verification; rebase would change the reviewed commit and requires new verification and review.");
      if (!rootIsAncestor) {
        try { await git(worktree, ["rebase", rootHead]); }
        catch (error) {
          await git(worktree, ["rebase", "--abort"]).catch((abortError) => projectLogger({ event_name: "ticket.integration_rebase_abort_failed", level: "error", status: "failed", message: "Ticket rebase cleanup failed.", task_id: taskId, source: "ticket-integration-service", error_code: abortError.code ?? "GIT_REBASE_ABORT_FAILED" }));
          throw failure("TICKET_INTEGRATION_CONFLICT", `Ticket commit cannot be rebased onto project HEAD: ${error.message}.`);
        }
        commit = await git(worktree, ["rev-parse", "HEAD"]);
      }
      const committedPaths = (await git(worktree, ["diff", "--name-only", rootHead, commit, "--"])).split("\n").filter(Boolean);
      if (committedPaths.some((path) => !paths.includes(path))) throw failure("TICKET_INTEGRATION_CONFLICT", "Ticket branch includes a file outside its change ledger.");
      for (const path of paths) {
        let rootContent = null;
        try { rootContent = await fileService.readFile({ path }); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (manifest.entries[path].latest_sha === null) {
          if (rootContent !== null || await git(worktree, ["ls-tree", "-r", "--name-only", commit, "--", path])) throw failure("TICKET_INTEGRATION_CONFLICT", `Deleted ticket file is still present: ${path}.`);
          continue;
        }
        const committed = await gitRaw(worktree, ["show", `${commit}:${path}`]);
        if (rootContent !== committed) throw failure("TICKET_INTEGRATION_CONFLICT", `Root source differs from reviewed ticket content: ${path}.`);
      }
      const currentHead = await git(projectRoot, ["rev-parse", "HEAD"]);
      if (currentHead !== rootHead) throw failure("TICKET_INTEGRATION_CONFLICT", "Project branch moved during integration.");
      const state = { task_id: taskId, branch, previous_head: rootHead, reviewed_commit: reviewed, commit, workspace_mode: "worktree", supervisor_id: null, recorded_at: new Date().toISOString() };
      await receipts.savePrepared(taskId, state);
      await git(projectRoot, ["update-ref", `refs/heads/${branch}`, commit, rootHead]);
      await git(projectRoot, ["read-tree", commit]);
      await receipts.saveCompleted(taskId, state);
      projectLogger({ event_name: "ticket.integration_completed", level: "info", status: "success", message: "Approved ticket commit integrated into project branch.", task_id: taskId, source: "ticket-integration-service", payload: { commit, previous_head: rootHead, path_count: paths.length } });
      return { sha: commit, previous_head: rootHead };
    } finally { await lock.release(); }
  }

  return Object.freeze({ integrate });
}
