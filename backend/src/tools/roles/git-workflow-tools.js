// Business purpose: Provides governed Git branch, restore, and stash tools (`git_branch`, `git_restore`, `git_stash`) through Node Git Service with automatic working-tree sha256 reconciliation and strict role/path scope enforcement.
// Technical description: Enforces read-only branch inspection for all roles, restricts mutating actions (`create`, `switch`, `delete_merged`, `git_restore`, `git_stash`) to System Engineer and Coder (failing closed on missing roles), rejects `.git` and `.forge` paths, and reconciles changed_paths, active_file_checksums, and deleted_paths on both success and failure.

import { snapshotWorkingTree, reconcileWorkingTreeMutation } from "../../infrastructure/git/workspace-ledger-sync.js";
import { authorizeTool, isAgentPathAllowed } from "../governance/tool-authorization.js";
import { ConfigurationError } from "../../shared/errors.js";
import {
  gitBranchDefinition,
  gitRestoreDefinition,
  gitStashDefinition
} from "./git-workflow-definitions.js";

export { gitBranchDefinition, gitRestoreDefinition, gitStashDefinition };

// Business purpose: Verifies that a project-relative path is permitted by both the role file access policy and any explicit allowed_file_paths or allowed_prefixes on the execution context.
// Technical description: Evaluates isAgentPathAllowed for the requested operation and, when allowed_file_paths or allowed_prefixes are configured on context, enforces that the normalized path matches an allowed file or directory prefix.
function isScopedMutationAllowed(path, context, operation = "write") {
  if (!isAgentPathAllowed(path, context, { operation })) return false;
  const files = context?.allowed_file_paths ?? context?.allowedFilePaths;
  const prefixes = context?.allowed_prefixes ?? context?.allowedPrefixes;
  if (!Array.isArray(files) && !Array.isArray(prefixes)) return true;
  const normalized = String(path ?? "").replace(/^\.\//, "").replace(/\/$/, "");
  const inFiles = Array.isArray(files) && files.includes(normalized);
  const inPrefixes = Array.isArray(prefixes) && prefixes.some((prefix) => {
    const clean = String(prefix ?? "").replace(/^\.\//, "").replace(/\/$/, "");
    return normalized === clean || normalized.startsWith(`${clean}/`);
  });
  return inFiles || inPrefixes;
}

// Business purpose: Creates the governed Git workflow tools (git_branch, git_restore, git_stash) bound to Node Git Service and workspace reconciliation.
// Technical description: Enforces role-level and action-level permissions, protected branch rules, protected path rejection, and post-mutation sha256 reconciliation on both success and failure.
export function createGitWorkflowTools({
  gitService,
  projectRoot,
  changeLedger,
  conversationStateStore,
  conversationId,
  logger
} = {}) {
  const hasGitService = Boolean(gitService && (typeof gitService.branch === "function" || typeof gitService.status === "function" || typeof gitService.commit === "function"));
  const tools = {};
  if (hasGitService) {
    tools.git_branch = Object.freeze({ name: "git_branch", definition: gitBranchDefinition, execute: executeBranch });
    tools.git_restore = Object.freeze({ name: "git_restore", definition: gitRestoreDefinition, execute: executeRestore });
    tools.git_stash = Object.freeze({ name: "git_stash", definition: gitStashDefinition, execute: executeStash });
  }
  return Object.freeze(tools);

  // Business purpose: Wraps a mutating Git operation in pre/post working-tree snapshots so any complete or partial working-tree changes are scope-checked and reconciled even when the Git operation fails.
  // Technical description: Captures beforeSnapshot, runs operation in try/catch, captures afterSnapshot in finally, validates delta scope before ledger write, reconciles checksums and deleted_paths, and rethrows any original error with reconciled metadata attached.
  async function runWithReconciliation({ toolName, context, candidatePaths = [], operation }) {
    const effectiveRoot = projectRoot ?? context?.project_root;
    const beforeSnapshot = await snapshotWorkingTree(effectiveRoot, { includeContent: Boolean(changeLedger) });
    let result;
    let opError = null;
    try {
      result = await operation();
    } catch (error) {
      opError = error;
    }
    const afterSnapshot = await snapshotWorkingTree(effectiveRoot, { includeContent: Boolean(changeLedger) });
    let scopeError = null;
    try {
      assertDeltaScope(beforeSnapshot, afterSnapshot, context, toolName);
    } catch (error) {
      scopeError = error;
    }
    const resolvedCandidates = typeof candidatePaths === "function" ? candidatePaths(result) : candidatePaths;
    const reconciled = await reconcileWorkingTreeMutation({
      projectRoot: effectiveRoot,
      beforeSnapshot,
      afterSnapshot,
      candidatePaths: Array.isArray(resolvedCandidates) ? resolvedCandidates : [],
      context,
      changeLedger: scopeError ? null : changeLedger,
      conversationStateStore,
      conversationId: conversationId ?? context?.conversation_id,
      logger,
      toolName
    });
    if (scopeError) {
      scopeError.changed_paths = reconciled.changed_paths;
      scopeError.active_file_checksums = reconciled.active_file_checksums;
      scopeError.deleted_paths = reconciled.deleted_paths;
      if (opError) scopeError.cause = opError;
      throw scopeError;
    }
    if (opError) {
      opError.changed_paths = reconciled.changed_paths;
      opError.active_file_checksums = reconciled.active_file_checksums;
      opError.deleted_paths = reconciled.deleted_paths;
      throw opError;
    }
    return {
      ...result,
      changed_paths: reconciled.changed_paths,
      active_file_checksums: reconciled.active_file_checksums,
      deleted_paths: reconciled.deleted_paths
    };
  }

  // Business purpose: Executes read-only or mutating branch operations with protected-branch checks and working-tree reconciliation on create and switch.
  // Technical description: Permits list/current for any role with git_branch capability; restricts create/switch/delete_merged to SE and Coder and reconciles working-tree state on create or switch.
  async function executeBranch(input = {}, context = {}) {
    authorizeTool("git_branch", context);
    assertAllowedKeys(input, ["action", "name", "start_point"], "git_branch");
    const action = input.action;
    if (!["list", "current", "create", "switch", "delete_merged"].includes(action)) {
      throw workflowError("GIT_BRANCH_INVALID_ACTION", "git_branch requires action: list, current, create, switch, or delete_merged.");
    }
    const isReadOnlyAction = action === "list" || action === "current";
    if (!isReadOnlyAction) {
      assertMutationRole("git_branch", action, context);
      if (typeof input.name !== "string" || !input.name.trim()) {
        throw workflowError("GIT_BRANCH_INVALID", `git_branch ${action} requires a branch name.`);
      }
    }

    const mutatesWorkingTree = action === "switch" || action === "create";
    if (!mutatesWorkingTree) {
      const result = await gitService.branch(input);
      logger?.emit?.({
        event_name: "forge.git_branch_completed",
        level: "info",
        status: "success",
        message: `git_branch ${action} completed.`,
        task_id: context?.task_id ?? "GIT-BRANCH",
        source: "git-workflow-tools",
        payload: { action, branch: result.branch ?? result.current ?? null }
      });
      return result;
    }

    return runWithReconciliation({
      toolName: "git_branch",
      context,
      operation: () => gitService.branch(input)
    });
  }

  // Business purpose: Restores explicit project-relative files in the working tree or unstages index entries without allowing global resets or protected path mutations.
  // Technical description: Validates non-empty paths within SE/Coder role scope, rejects .git/.forge paths, runs gitService.restore under mutationLock, and reconciles sha256 checksums and deleted_paths.
  async function executeRestore(input = {}, context = {}) {
    authorizeTool("git_restore", context);
    assertMutationRole("git_restore", input?.action ?? "restore", context);
    assertAllowedKeys(input, ["action", "paths", "source"], "git_restore");
    if (!["restore_worktree", "unstage"].includes(input.action)) {
      throw workflowError("GIT_RESTORE_INVALID", "git_restore requires action: restore_worktree or unstage.");
    }
    if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > 64) {
      throw workflowError("GIT_RESTORE_PATHS_REQUIRED", "git_restore requires an explicit non-empty paths array (1..64 items); global reset is forbidden.");
    }
    for (const rawPath of input.paths) {
      validateMutatingGitPath(rawPath, context, "git_restore", "GIT_RESTORE_PATH_INVALID");
    }

    return runWithReconciliation({
      toolName: "git_restore",
      context,
      candidatePaths: (res) => res?.restored_paths ?? input.paths,
      operation: () => gitService.restore(input)
    });
  }

  // Business purpose: Executes governed Git stash operations (list, push, pop, apply) and reconciles working-tree file checksums and deleted_paths after mutations.
  // Technical description: Validates stash parameters, rejects .git/.forge paths, enforces SE/Coder path scope, calls gitService.stash, and runs runWithReconciliation for push/pop/apply.
  async function executeStash(input = {}, context = {}) {
    authorizeTool("git_stash", context);
    assertAllowedKeys(input, ["action", "message", "paths", "index"], "git_stash");
    const action = input.action;
    if (!["list", "push", "pop", "apply"].includes(action)) {
      throw workflowError("GIT_STASH_INVALID", "git_stash requires action: list, push, pop, or apply.");
    }
    assertMutationRole("git_stash", action, context);
    let effectivePaths = input.paths;
    if (input.paths !== undefined) {
      if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > 64) {
        throw workflowError("GIT_STASH_INVALID", "git_stash paths must be a non-empty array of 1..64 project-relative paths.");
      }
      for (const rawPath of input.paths) {
        validateMutatingGitPath(rawPath, context, "git_stash", "GIT_STASH_INVALID");
      }
    } else if (action === "push") {
      const hasExplicitScope = Array.isArray(context?.allowed_file_paths ?? context?.allowedFilePaths) || Array.isArray(context?.allowed_prefixes ?? context?.allowedPrefixes);
      if (hasExplicitScope || context?.agent_identity?.role === "coder") {
        if (typeof gitService.status !== "function") {
          throw workflowError("GIT_STASH_INVALID", "git_stash push requires explicit paths when executing in a scoped Coder context.");
        }
        const statusOut = await gitService.status({ paths: [] });
        const dirtyPaths = [...new Set(
          String(statusOut ?? "").split(/\r?\n/).filter(Boolean).flatMap((line) => {
            const raw = line.slice(3).trim();
            const parts = raw.includes(" -> ") ? raw.split(" -> ") : [raw];
            return parts.map((p) => p.trim().replace(/^"|"$/g, "")).filter(Boolean);
          })
        )];
        if (!dirtyPaths.length) {
          throw workflowError("GIT_STASH_INVALID", "git_stash push requires explicit paths when executing in a scoped Coder context.");
        }
        for (const dirtyPath of dirtyPaths) {
          validateMutatingGitPath(dirtyPath, context, "git_stash", "GIT_STASH_INVALID");
        }
        effectivePaths = dirtyPaths;
      }
    }

    if (action === "list") {
      return gitService.stash({ action: "list" });
    }

    const stashPayload = effectivePaths !== undefined ? { ...input, paths: effectivePaths } : input;
    return runWithReconciliation({
      toolName: "git_stash",
      context,
      candidatePaths: effectivePaths ?? [],
      operation: () => gitService.stash(stashPayload)
    });
  }
}

// Business purpose: Validates a project-relative path for Git mutations so protected .git/.forge directories and out-of-scope paths are rejected for both SE and Coder.
// Technical description: Rejects absolute paths, parent traversal (..), NUL bytes, .git/.forge segments, and paths disallowed by isScopedMutationAllowed.
function validateMutatingGitPath(rawPath, context, toolName, invalidCode) {
  if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0")) {
    throw workflowError(invalidCode, `${toolName} requires safe project-relative paths: ${rawPath}`);
  }
  const normalized = rawPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = normalized.split("/").filter(Boolean);
  if (normalized.startsWith("/") || segments.includes("..")) {
    throw workflowError(invalidCode, `${toolName} requires safe project-relative paths: ${rawPath}`);
  }
  if (segments.includes(".git") || segments.includes(".forge")) {
    throw workflowError("GIT_PROTECTED_PATH", `${toolName} forbids protected internal directory (.git or .forge): ${rawPath}`);
  }
  if (!isScopedMutationAllowed(normalized, context, "write")) {
    throw workflowError("TOOL_RESOURCE_FORBIDDEN", `${toolName} path is outside the authorized write scope: ${rawPath}`);
  }
}

// Business purpose: Verifies that any working-tree files modified or deleted by a Git branch/restore/stash operation remain within the caller's authorized scope.
// Technical description: Compares beforeSnapshot and afterSnapshot and checks modified/created paths with operation="write" and deleted paths with operation="delete".
function assertDeltaScope(beforeSnapshot, afterSnapshot, context, toolName) {
  for (const [path, meta] of afterSnapshot.entries()) {
    const prev = beforeSnapshot.get(path);
    if ((!prev || prev.sha256 !== meta.sha256) && !isScopedMutationAllowed(path, context, "write")) {
      throw workflowError("TOOL_RESOURCE_FORBIDDEN", `${toolName} modified path outside authorized scope: ${path}`);
    }
  }
  for (const [path] of beforeSnapshot.entries()) {
    if (!afterSnapshot.has(path) && !isScopedMutationAllowed(path, context, "delete")) {
      throw workflowError("TOOL_RESOURCE_FORBIDDEN", `${toolName} deleted path outside authorized scope: ${path}`);
    }
  }
}

// Business purpose: Rejects unexpected keys on Git workflow tool inputs.
// Technical description: Validates Object.keys(input) against allowedKeys.
function assertAllowedKeys(input, allowedKeys, toolName) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw workflowError("GIT_WORKFLOW_INPUT_INVALID", `${toolName} requires a plain input object.`);
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw workflowError("GIT_WORKFLOW_INPUT_INVALID", `Unexpected ${toolName} field: ${key}.`);
    }
  }
}

// Business purpose: Ensures only System Engineer and Coder can invoke mutating Git workflow actions and fails closed when role identity is missing or planning_input_only is active.
// Technical description: Checks context.planning_input_only and requires context.agent_identity.role to be system_engineer or coder, throwing TOOL_FORBIDDEN otherwise.
function assertMutationRole(toolName, action, context) {
  if (context?.planning_input_only === true) {
    throw workflowError("TOOL_FORBIDDEN", `Planning input mode forbids mutating ${toolName} action '${action}'.`);
  }
  const role = context?.agent_identity?.role;
  if (!role || !["system_engineer", "coder"].includes(role)) {
    throw workflowError("TOOL_FORBIDDEN", `${toolName} action '${action}' is permitted only for System Engineer and Coder.`);
  }
}

// Business purpose: Creates a typed ConfigurationError with a stable error code for Git workflow tool failures.
// Technical description: Attaches code to a ConfigurationError instance.
function workflowError(code, message) {
  return Object.assign(new ConfigurationError(message), { code });
}
