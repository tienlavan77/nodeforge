// Business purpose: Provides read-only Git repository inspection tools (git_status, git_diff, git_log, git_show, git_blame) through Node Git Service for all agent roles and read-only explorer subagents.
// Technical description: Enforces capability authorization, Coder read-scope filtering, and bounded output sizes while delegating to Node Git Service methods and shared helpers in git-read-helpers.js.

import { logEvent } from "../../core/project-log-service.js";
import { createRuntimeLogger } from "../../core/runtime-logger.js";
import { authorizeTool } from "../governance/tool-authorization.js";
import { ConfigurationError } from "../../shared/errors.js";
import {
  assertAllowedKeys,
  assertOutputSize,
  assertPlainObject,
  gitBlameDefinition,
  gitLogDefinition,
  gitShowDefinition,
  invalidInput,
  normalizeInputPaths,
  resolveScopedPaths,
  summarizeGitStatus
} from "./git-read-helpers.js";

export { gitLogDefinition, gitShowDefinition, gitBlameDefinition };

// Business purpose: Creates the scoped read-only Git toolset backed by the project's Node Git Service.
// Technical description: Registers git_status, git_diff, git_log, git_show, and git_blame with consistent authorization and audit events.
export function createGitReadTools({ gitService, logger = createRuntimeLogger({ logEvent }) } = {}) {
  if (typeof gitService?.status !== "function" || typeof gitService?.diffWorkingTree !== "function") {
    throw new ConfigurationError("Git read tools require Git Service status and diffWorkingTree.");
  }

  return Object.freeze({
    git_status: Object.freeze({ name: "git_status", execute: executeStatus }),
    git_diff: Object.freeze({ name: "git_diff", execute: executeDiff }),
    git_log: Object.freeze({ name: "git_log", definition: gitLogDefinition, execute: executeLog }),
    git_show: Object.freeze({ name: "git_show", definition: gitShowDefinition, execute: executeShow }),
    git_blame: Object.freeze({ name: "git_blame", definition: gitBlameDefinition, execute: executeBlame })
  });

  // Business purpose: Executes git_status with optional path filtering and returns rich branch/status context while preserving legacy fields.
  // Technical description: Validates optional paths, applies Coder path scope, calls gitService.inspectStatus or gitService.status, and emits audit events.
  async function executeStatus(input = {}, context = {}) {
    const started = Date.now();
    let requestedPaths;
    try {
      authorizeTool("git_status", context);
      assertPlainObject(input, "git_status");
      assertAllowedKeys(input, ["paths"], "git_status");
      requestedPaths = normalizeInputPaths(input.paths, "git_status", context);
    } catch (error) {
      emit("git_status", "rejected", context, { error_code: error.code ?? "GIT_READ_INPUT_INVALID", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
    emit("git_status", "started", context, { operation: "status" });
    try {
      const effectivePaths = resolveScopedPaths(requestedPaths, context, "git_status");
      const rich = typeof gitService.inspectStatus === "function"
        ? await gitService.inspectStatus(effectivePaths ? { paths: effectivePaths } : undefined)
        : null;
      const stdout = rich ? rich.stdout : await gitService.status(effectivePaths ? { paths: effectivePaths } : undefined);
      if (typeof stdout !== "string") throw invalidInput("Git Service returned invalid output.");
      assertOutputSize("git_status", stdout);
      const summary = summarizeGitStatus(stdout, rich);
      emit("git_status", "completed", context, {
        operation: "status",
        working_tree: summary.working_tree,
        changed_files: summary.changed_files,
        staged_files: summary.staged_files,
        unstaged_files: summary.unstaged_files,
        untracked_files: summary.untracked_files,
        conflicted_files: summary.conflicted_files,
        stdout_bytes: Buffer.byteLength(stdout),
        duration_ms: Date.now() - started
      });
      return { stdout, stderr: "", exit_code: 0, ...summary };
    } catch (error) {
      emit("git_status", "failed", context, { operation: "status", error_code: error.code ?? "GIT_READ_FAILED", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
  }

  // Business purpose: Executes git_diff with optional path, base/head, staged, stat_only, and unified context filters to prevent oversized diff errors.
  // Technical description: Validates filter parameters, applies Coder scope, delegates to gitService.diff or gitService.diffWorkingTree, and enforces MAX_OUTPUT_BYTES.
  async function executeDiff(input = {}, context = {}) {
    const started = Date.now();
    let requestedPaths;
    try {
      authorizeTool("git_diff", context);
      assertPlainObject(input, "git_diff");
      assertAllowedKeys(input, ["paths", "base", "head", "staged", "stat_only", "unified"], "git_diff");
      requestedPaths = normalizeInputPaths(input.paths, "git_diff", context);
      if (input.base !== undefined && (typeof input.base !== "string" || !input.base.trim() || input.base.length > 120 || input.base.startsWith("-"))) {
        throw invalidInput("git_diff base must be a valid revision string.");
      }
      if (input.head !== undefined && (typeof input.head !== "string" || !input.head.trim() || input.head.length > 120 || input.head.startsWith("-"))) {
        throw invalidInput("git_diff head must be a valid revision string.");
      }
      if (input.head !== undefined && input.base === undefined) throw invalidInput("git_diff head requires base revision.");
      if (input.staged !== undefined && typeof input.staged !== "boolean") throw invalidInput("git_diff staged must be a boolean.");
      if (input.stat_only !== undefined && typeof input.stat_only !== "boolean") throw invalidInput("git_diff stat_only must be a boolean.");
      if (input.unified !== undefined && (!Number.isInteger(input.unified) || input.unified < 0 || input.unified > 20)) {
        throw invalidInput("git_diff unified must be an integer between 0 and 20.");
      }
    } catch (error) {
      emit("git_diff", "rejected", context, { error_code: error.code ?? "GIT_READ_INPUT_INVALID", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
    emit("git_diff", "started", context, { operation: "diffWorkingTree" });
    try {
      const effectivePaths = resolveScopedPaths(requestedPaths, context, "git_diff");
      const hasExtendedArgs = input.base !== undefined || input.head !== undefined || input.staged !== undefined || input.stat_only !== undefined || input.unified !== undefined;
      const stdout = hasExtendedArgs && typeof gitService.diff === "function"
        ? await gitService.diff({
            ...(effectivePaths ? { paths: effectivePaths } : {}),
            ...(input.base !== undefined ? { base: input.base } : {}),
            ...(input.head !== undefined ? { head: input.head } : {}),
            ...(input.staged !== undefined ? { staged: input.staged } : {}),
            ...(input.stat_only !== undefined ? { stat_only: input.stat_only } : {}),
            ...(input.unified !== undefined ? { unified: input.unified } : {})
          })
        : await gitService.diffWorkingTree(effectivePaths ? { paths: effectivePaths } : undefined);
      if (typeof stdout !== "string") throw invalidInput("Git Service returned invalid output.");
      assertOutputSize("git_diff", stdout);
      const summary = { has_changes: stdout.length > 0 };
      emit("git_diff", "completed", context, { operation: "diffWorkingTree", ...summary, stdout_bytes: Buffer.byteLength(stdout), duration_ms: Date.now() - started });
      return { stdout, stderr: "", exit_code: 0, ...summary };
    } catch (error) {
      emit("git_diff", "failed", context, { operation: "diffWorkingTree", error_code: error.code ?? "GIT_READ_FAILED", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
  }

  // Business purpose: Executes git_log to retrieve structured commit history with optional path, revision, grep, and limit filters.
  // Technical description: Validates parameters, scopes paths for Coder, calls gitService.log, and checks output size limits.
  async function executeLog(input = {}, context = {}) {
    const started = Date.now();
    let requestedPaths;
    try {
      authorizeTool("git_log", context);
      assertPlainObject(input, "git_log");
      assertAllowedKeys(input, ["limit", "path", "revision", "grep"], "git_log");
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) {
        throw invalidInput("git_log limit must be an integer between 1 and 100.");
      }
      if (input.revision !== undefined && (typeof input.revision !== "string" || !input.revision.trim() || input.revision.length > 120 || input.revision.startsWith("-"))) {
        throw invalidInput("git_log revision must be a valid revision string.");
      }
      if (input.grep !== undefined && (typeof input.grep !== "string" || !input.grep.trim() || input.grep.length > 200)) {
        throw invalidInput("git_log grep must be a non-empty string up to 200 characters.");
      }
      requestedPaths = input.path !== undefined ? normalizeInputPaths([input.path], "git_log", context) : undefined;
    } catch (error) {
      emit("git_log", "rejected", context, { error_code: error.code ?? "GIT_READ_INPUT_INVALID", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
    emit("git_log", "started", context, { operation: "log" });
    try {
      const effectivePaths = resolveScopedPaths(requestedPaths, context, "git_log");
      const result = await gitService.log({
        limit: input.limit ?? 20,
        ...(effectivePaths ? { paths: effectivePaths } : {}),
        ...(input.revision !== undefined ? { revision: input.revision } : {}),
        ...(input.grep !== undefined ? { grep: input.grep } : {})
      });
      const serialized = JSON.stringify(result);
      assertOutputSize("git_log", serialized);
      emit("git_log", "completed", context, { operation: "log", count: result.commits?.length ?? 0, stdout_bytes: Buffer.byteLength(serialized), duration_ms: Date.now() - started });
      return result;
    } catch (error) {
      emit("git_log", "failed", context, { operation: "log", error_code: error.code ?? "GIT_READ_FAILED", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
  }

  // Business purpose: Executes git_show to inspect a commit or read a single file's historical content and sha256 at a revision.
  // Technical description: Validates revision and optional path/paths/stat_only, applies Coder scope, calls gitService.show, and enforces MAX_OUTPUT_BYTES.
  async function executeShow(input = {}, context = {}) {
    const started = Date.now();
    let singlePath;
    let filterPaths;
    try {
      authorizeTool("git_show", context);
      assertPlainObject(input, "git_show");
      assertAllowedKeys(input, ["revision", "path", "paths", "stat_only"], "git_show");
      if (typeof input.revision !== "string" || !input.revision.trim() || input.revision.length > 120 || input.revision.startsWith("-")) {
        throw invalidInput("git_show requires a valid revision string.");
      }
      if (input.stat_only !== undefined && typeof input.stat_only !== "boolean") throw invalidInput("git_show stat_only must be a boolean.");
      if (input.path !== undefined) [singlePath] = normalizeInputPaths([input.path], "git_show", context);
      if (input.paths !== undefined) filterPaths = normalizeInputPaths(input.paths, "git_show", context);
    } catch (error) {
      emit("git_show", "rejected", context, { error_code: error.code ?? "GIT_READ_INPUT_INVALID", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
    emit("git_show", "started", context, { operation: "show" });
    try {
      const effectivePaths = singlePath ? undefined : resolveScopedPaths(filterPaths, context, "git_show");
      const result = await gitService.show({
        revision: input.revision,
        ...(singlePath ? { path: singlePath } : {}),
        ...(effectivePaths ? { paths: effectivePaths } : {}),
        ...(input.stat_only !== undefined ? { stat_only: input.stat_only } : {})
      });
      const serialized = typeof result.stdout === "string" ? result.stdout : typeof result.content === "string" ? result.content : JSON.stringify(result);
      assertOutputSize("git_show", serialized);
      emit("git_show", "completed", context, { operation: "show", stdout_bytes: Buffer.byteLength(serialized), duration_ms: Date.now() - started });
      return result;
    } catch (error) {
      emit("git_show", "failed", context, { operation: "show", error_code: error.code ?? "GIT_READ_FAILED", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
  }

  // Business purpose: Executes git_blame to inspect line-by-line commit attribution for a project file within a 200-line window.
  // Technical description: Validates path and line range (max 200 lines), checks Coder read scope, and calls gitService.blame.
  async function executeBlame(input = {}, context = {}) {
    const started = Date.now();
    let targetPath;
    try {
      authorizeTool("git_blame", context);
      assertPlainObject(input, "git_blame");
      assertAllowedKeys(input, ["path", "start_line", "end_line"], "git_blame");
      if (typeof input.path !== "string" || !input.path.trim()) throw invalidInput("git_blame requires a project-relative path.");
      [targetPath] = normalizeInputPaths([input.path], "git_blame", context);
      const startLine = input.start_line ?? 1;
      const endLine = input.end_line ?? startLine + 199;
      if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(endLine) || endLine < startLine) {
        throw invalidInput("git_blame start_line and end_line must be positive integers with end_line >= start_line.");
      }
      if (endLine - startLine + 1 > 200) {
        const rangeErr = invalidInput("git_blame range cannot exceed 200 lines per call.");
        rangeErr.code = "GIT_BLAME_RANGE_TOO_LARGE";
        throw rangeErr;
      }
    } catch (error) {
      emit("git_blame", "rejected", context, { error_code: error.code ?? "GIT_READ_INPUT_INVALID", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
    emit("git_blame", "started", context, { operation: "blame" });
    try {
      const result = await gitService.blame({
        path: targetPath,
        start_line: input.start_line ?? 1,
        ...(input.end_line !== undefined ? { end_line: input.end_line } : {})
      });
      const serialized = JSON.stringify(result);
      assertOutputSize("git_blame", serialized);
      emit("git_blame", "completed", context, { operation: "blame", line_count: result.lines?.length ?? 0, stdout_bytes: Buffer.byteLength(serialized), duration_ms: Date.now() - started });
      return result;
    } catch (error) {
      emit("git_blame", "failed", context, { operation: "blame", error_code: error.code ?? "GIT_READ_FAILED", error: error.message, duration_ms: Date.now() - started });
      throw error;
    }
  }

  // Persists audit metadata without copying repository status or patch content.
  function emit(name, phase, context, payload) {
    const status = phase === "completed" ? "success" : phase === "started" ? "started" : "failed";
    logger.emit({
      event_name: `forge.${name}_${phase}`,
      level: status === "failed" ? "error" : "info",
      status,
      message: `${name} ${status}.`,
      task_id: context?.task_id ?? context?.taskId ?? "GIT-READ-UNSCOPED",
      correlation_id: context?.correlation_id,
      source: "git-read-tools",
      ...(payload.error_code ? { error_code: payload.error_code } : {}),
      payload: { agent_id: context?.agent_identity?.agent_id, execution_id: context?.execution_id, ...payload }
    });
  }
}
