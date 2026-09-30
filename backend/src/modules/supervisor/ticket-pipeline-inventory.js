// Classifies existing ticket runtime records before enabling immutable evidence gates.
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ConfigurationError } from "../../shared/errors.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const SAFE_TASK = /^[A-Za-z0-9._:-]+$/;
const execFile = promisify(execFileCallback);

// Reads only metadata from project-scoped worktrees, contexts, ledgers, and checkpoints.
export function createTicketPipelineInventory({ projectRoot, projectId, fileService } = {}) {
  if (!projectRoot || !projectId || !fileService?.listFiles || !fileService?.readFile) throw new ConfigurationError("Ticket pipeline inventory requires project File Service and identity.");
  const root = resolve(projectRoot);
  const contextRoot = `.forge/runtime/ticket-execution-contexts/${hash(projectId)}`;
  const ledgerRoot = `.forge/runtime/ticket-changes/${hash(projectId)}/tickets`;
  const worktreeRoot = join(root, ".forge/worktrees/tickets");
  return Object.freeze({ inspect });

  // Classifies legacy evidence without attaching an artifact or claiming a file.
  async function inspect() {
    const records = new Map();
    const entry = (taskId) => {
      if (!SAFE_TASK.test(taskId ?? "")) throw new ConfigurationError("Ticket inventory encountered an unsafe task ID.");
      if (!records.has(taskId)) records.set(taskId, { task_id: taskId, worktree: false, checkpoint: false, reviewer_checkpoint: false, ledger: false, context: false, cached_job: false, review_only: false, classification: null, reasons: [] });
      return records.get(taskId);
    };
    let worktrees = [];
    try { worktrees = await readdir(worktreeRoot, { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const item of worktrees) if (item.isDirectory() && SAFE_TASK.test(item.name)) entry(item.name).worktree = true;
    const sources = [
      { glob: `${contextRoot}/*.json`, kind: "context" },
      { glob: `${ledgerRoot}/*.json`, kind: "ledger" },
      { glob: ".forge/runtime/agent-checkpoints/*.json", kind: "checkpoint" },
      { glob: ".forge/runtime/ticket-verification/*/jobs/*.json", kind: "cached_job" },
      { glob: ".forge/runtime/reviewer-checkpoints/*.json", kind: "reviewer_checkpoint" },
      { glob: ".forge/runtime/ticket-workspaces/*.json", kind: "workspace_state" }
    ];
    for (const source of sources) for (const path of await fileService.listFiles({ glob: source.glob })) {
      const value = JSON.parse(await fileService.readFile({ path }));
      if (source.kind === "checkpoint" && ["completed", "blocked"].includes(value.status)) continue;
      if (source.kind === "reviewer_checkpoint" && value.status === "completed" && value.verdict === "approved") continue;
      if (source.kind === "ledger" && value.state === "closed") continue;
      if (source.kind === "context" && value.state === "terminal") continue;
      const taskId = value.task_id ?? value.taskId ?? (source.kind === "context" ? path.split("/").at(-1).replace(/\.json$/, "") : null);
      if (!taskId || value.project_id && value.project_id !== projectId) continue;
      const record = entry(taskId);
      record[source.kind] = true;
      if (source.kind === "context") record.context_state = value.state ?? null;
      if (source.kind === "ledger") record.ledger_revision = value.revision ?? null;
      if (source.kind === "cached_job") record.job_status = value.status ?? null;
      if (source.kind === "reviewer_checkpoint") record.review_only = value.review_only === true;
      if (source.kind === "workspace_state") record.base_commit = value.base_commit ?? null;
    }
    for (const record of records.values()) {
      if (record.worktree) {
        try {
          const { stdout } = await execFile("git", ["-C", join(worktreeRoot, record.task_id), "rev-parse", "HEAD"], { timeout: 5000 });
          record.worktree_head = stdout.trim();
        } catch (error) { record.reasons.push("worktree_unreadable"); record.worktree_error = error.code ?? "GIT_FAILED"; }
      }
      if (record.worktree && (!record.base_commit || record.worktree_head !== record.base_commit) && !record.context) record.reasons.push("pre_context_worktree_commit");
      if (!record.context && (record.ledger || record.checkpoint || record.reviewer_checkpoint || record.review_only)) record.reasons.push("pre_context_activity");
      if (record.cached_job && !record.context) record.reasons.push("unbound_test_job");
      if (record.context && !record.ledger) record.reasons.push("context_without_ledger");
      if (record.job_status === "running") record.reasons.push("interrupted_test_job");
      record.classification = record.reasons.includes("interrupted_test_job") || record.reasons.includes("context_without_ledger") || record.reasons.includes("worktree_unreadable") ? "stale" : record.reasons.length ? "human-review-required" : "migratable";
      delete record.worktree_error;
    }
    return { project_id: projectId, inspected_at: new Date().toISOString(), tickets: [...records.values()].sort((a, b) => a.task_id.localeCompare(b.task_id)) };
  }
}
