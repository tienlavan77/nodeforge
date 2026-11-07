// Business purpose: Implements governed Git workflow operations (branch queries/mutations, path-scoped restore/unstage, and stash management) for Node Git Service.
// Technical description: Bound to Git Service execution, mutationLock guard, protected-branch sets, and audit emission so git-service-extended.js remains under the 250-line budget.

import { ConfigurationError } from "../../shared/errors.js";

// Business purpose: Creates the branch, restore, and stash operation handlers for Node Git Service.
// Technical description: Wraps mutating branch, restore, and stash actions in guard (mutationLock) while keeping list/current queries read-only.
export function createGitWorkflowServiceOps({
  execute,
  guard,
  emit,
  currentBranch,
  branchExists,
  validateRevision,
  validateBranch,
  validatePaths,
  gitError,
  protectedBranches
}) {
  return {
    branch: async (input = {}) => {
      const action = input?.action;
      if (action === "list" || action === "current") return branchRead(input);
      return guard(branchMutate)(input);
    },
    restore: guard(restore),
    stash: async (input = {}) => {
      if (input?.action === "list") return stashList();
      return guard(stashMutate)(input);
    }
  };

  // Business purpose: Executes read-only branch queries (list and current) for any authorized agent role.
  // Technical description: Queries currentBranch and git branch --format to return branch names and HEAD SHA without mutating repository state.
  async function branchRead({ action } = {}) {
    const current = (await currentBranch()) || null;
    if (action === "current") return { action: "current", branch: current };
    const result = await execute(["branch", "--format=%(refname:short)%09%(objectname:short)"], "GIT_BRANCH_FAILED");
    if (result.exitCode !== 0) throw gitError("GIT_BRANCH_FAILED", `Git branch list failed: ${result.stderr ?? "unknown Git error"}`);
    const branches = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [name, head_sha] = line.split("\t");
      return { name: name.trim(), head_sha: (head_sha ?? "").trim(), current: name.trim() === current, protected: protectedBranches.has(name.trim()) };
    });
    return { action: "list", current, branches };
  }

  // Business purpose: Executes governed branch mutations (create, switch, delete_merged) under mutationLock while protecting main/master/production branches.
  // Technical description: Validates branch names and optional start_point, prevents deleting or overwriting protected branches, and emits git.branch audit events.
  async function branchMutate({ action, name, start_point } = {}) {
    if (!["create", "switch", "delete_merged"].includes(action)) {
      throw gitError("GIT_BRANCH_INVALID_ACTION", `Unsupported git_branch action: ${action ?? "<missing>"}.`);
    }
    validateBranch(name);
    if (action === "create") {
      if (protectedBranches.has(name)) throw gitError("GIT_PROTECTED_BRANCH", `Cannot create or overwrite protected branch: ${name}.`);
      if (await branchExists(name)) throw gitError("GIT_BRANCH_EXISTS", `Git branch already exists: ${name}.`);
      if (start_point !== undefined) validateRevision(start_point);
      const args = ["switch", "-c", name, ...(start_point ? [start_point] : [])];
      const res = await execute(args, "GIT_BRANCH_CREATE_FAILED");
      if (res.exitCode !== 0) throw gitError("GIT_BRANCH_CREATE_FAILED", `Git branch create failed: ${res.stderr ?? "unknown Git error"}`);
      const head = (await execute(["rev-parse", "HEAD"], "GIT_BRANCH_FAILED")).stdout.trim();
      emit("git.branch", { action: "create", name, base_commit: head });
      return { action: "create", branch: name, base_commit: head };
    }
    if (action === "switch") {
      if (!(await branchExists(name))) throw gitError("GIT_BRANCH_NOT_FOUND", `Git branch does not exist: ${name}.`);
      const res = await execute(["switch", name], "GIT_BRANCH_SWITCH_FAILED");
      if (res.exitCode !== 0) throw gitError("GIT_BRANCH_SWITCH_FAILED", `Git branch switch failed: ${res.stderr ?? "unknown Git error"}`);
      const head = (await execute(["rev-parse", "HEAD"], "GIT_BRANCH_FAILED")).stdout.trim();
      emit("git.branch", { action: "switch", name, head_sha: head });
      return { action: "switch", branch: name, head_sha: head };
    }
    if (protectedBranches.has(name)) throw gitError("GIT_PROTECTED_BRANCH", `Cannot delete protected branch: ${name}.`);
    if (name === await currentBranch()) throw gitError("GIT_CURRENT_BRANCH", `Cannot delete the current branch: ${name}.`);
    if (!(await branchExists(name))) throw gitError("GIT_BRANCH_NOT_FOUND", `Git branch does not exist: ${name}.`);
    const del = await execute(["branch", "-d", name], "GIT_BRANCH_DELETE_FAILED");
    if (del.exitCode !== 0) throw gitError("GIT_BRANCH_DELETE_FAILED", `Git branch delete failed: ${del.stderr ?? "unknown Git error"}`);
    emit("git.branch", { action: "delete_merged", name });
    return { action: "delete_merged", branch: name, deleted: true };
  }

  // Business purpose: Restores specific working-tree files or unstages index entries without allowing destructive global resets.
  // Technical description: Requires a non-empty array of safe relative paths, validates optional source revision, and executes git restore under mutationLock.
  async function restore({ action, paths, source } = {}) {
    if (!["restore_worktree", "unstage"].includes(action)) {
      throw gitError("GIT_RESTORE_INVALID", `Unsupported git_restore action: ${action ?? "<missing>"}.`);
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new ConfigurationError("git_restore requires explicit non-empty paths; global reset is forbidden.");
    }
    const safePaths = validatePaths(paths);
    if (source !== undefined) validateRevision(source);
    const args = ["restore"];
    if (action === "unstage") {
      args.push("--staged");
    } else {
      args.push("--worktree");
      if (source !== undefined) args.push(`--source=${source}`);
    }
    args.push("--", ...safePaths);
    const result = await execute(args, "GIT_RESTORE_FAILED");
    if (result.exitCode !== 0) throw gitError("GIT_RESTORE_FAILED", `Git restore failed: ${result.stderr ?? "unknown Git error"}`);
    emit("git.restore", { action, paths: safePaths, ...(source ? { source } : {}) });
    return { action, restored_paths: safePaths, ...(source ? { source } : {}) };
  }

  // Business purpose: Lists current Git stash entries without modifying the working tree.
  // Technical description: Runs git stash list with structured format and returns an array of stash entries.
  async function stashList() {
    const result = await execute(["stash", "list", "--format=%gd%x09%H%x09%gs"], "GIT_STASH_FAILED");
    if (result.exitCode !== 0) throw gitError("GIT_STASH_FAILED", `Git stash list failed: ${result.stderr ?? "unknown Git error"}`);
    const stashes = result.stdout.split(/\r?\n/).filter(Boolean).map((line, index) => {
      const [ref = `stash@{${index}}`, sha = "", message = ""] = line.split("\t");
      return { index, ref: ref.trim(), sha: sha.trim(), message: message.trim() };
    });
    return { action: "list", stashes };
  }

  // Business purpose: Executes governed Git stash mutations (push, pop, apply) under mutationLock.
  // Technical description: Validates stash action, optional message, path filters, and stash index before executing git stash.
  async function stashMutate({ action, message, paths = [], index = 0 } = {}) {
    if (!["push", "pop", "apply"].includes(action)) {
      throw gitError("GIT_STASH_INVALID", `Unsupported git_stash action: ${action ?? "<missing>"}.`);
    }
    if (action === "push") {
      const safePaths = paths.length ? validatePaths(paths) : [];
      if (message !== undefined && (typeof message !== "string" || !message.trim() || message.length > 200)) {
        throw gitError("GIT_STASH_INVALID", "git_stash message must be 1..200 characters.");
      }
      const args = ["stash", "push", "-u"];
      if (message) args.push("-m", message.trim());
      if (safePaths.length) args.push("--", ...safePaths);
      const res = await execute(args, "GIT_STASH_FAILED");
      if (res.exitCode !== 0) throw gitError("GIT_STASH_FAILED", `Git stash push failed: ${res.stderr ?? "unknown Git error"}`);
      emit("git.stash", { action: "push", paths: safePaths });
      return { action: "push", paths: safePaths, output: res.stdout.trim() };
    }
    if (!Number.isInteger(index) || index < 0 || index > 50) {
      throw gitError("GIT_STASH_INVALID", "git_stash index must be an integer between 0 and 50.");
    }
    const ref = `stash@{${index}}`;
    const res = await execute(["stash", action, ref], "GIT_STASH_FAILED");
    if (res.exitCode !== 0) throw gitError("GIT_STASH_FAILED", `Git stash ${action} failed: ${res.stderr ?? "unknown Git error"}`);
    emit("git.stash", { action, index });
    return { action, index, ref, output: res.stdout.trim() };
  }
}
