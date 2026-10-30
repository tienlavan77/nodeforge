// Summary: Enforces Node-issued capabilities and task scope for agent tools.

import { ConfigurationError } from "../../shared/errors.js";
import { assertExecutionFileAccess, executionFileAccessAllowed } from "../execution-file-access.js";
import { isCoderProjectPath } from "../../infrastructure/filesystem/coder-project-access.js";

export function authorizeTool(toolName, context = {}) {
  assertExecutionFileAccess(context);
  const capabilities = new Set(context.capabilities ?? []);
  if (!capabilities.has(toolName)) {
    const error = new ConfigurationError(`Agent is not authorized to use ${toolName}.`);
    error.code = "TOOL_FORBIDDEN";
    throw error;
  }
  if (typeof (context.task_id ?? context.taskId) !== "string" || !(context.task_id ?? context.taskId)) {
    const error = new ConfigurationError("Tool authorization requires the current task_id.");
    error.code = "TOOL_SCOPE_INVALID";
    throw error;
  }
  return true;
}

// Retains the legacy path predicate while enforcing project containment for Coder mutations.
export function isCoderBlockedPath(path, context = {}, { operation = "read" } = {}) {
  if (context.agent_identity?.role !== "coder" || typeof path !== "string" || operation === "read") return false;
  return !isCoderProjectPath(path);
}

// Checks a project path against the file and directory scope granted to the agent.
export function isAgentPathAllowed(path, context = {}, { operation = "read" } = {}) {
  const policyAllowed = executionFileAccessAllowed(path, context, operation);
  if (policyAllowed !== null) return policyAllowed;
  if (context.agent_identity?.role === "coder") return operation === "read" && path === "." || isCoderProjectPath(path);
  if (isCoderBlockedPath(path, context, { operation })) return false;
  const files = context.allowed_file_paths ?? context.allowedFilePaths;
  const prefixes = context.allowed_prefixes ?? context.allowedPrefixes;
  if (!Array.isArray(files) && !Array.isArray(prefixes)) return context.agent_identity?.role !== "coder";
  if (operation === "read" && context.agent_identity?.role === "coder" && typeof path === "string" && (path === "docs" || path.startsWith("docs/"))) return true;
  return (Array.isArray(files) && files.includes(path)) || (Array.isArray(prefixes) && prefixes.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(`${prefix.replace(/\/$/, "")}/`)));
}
