// Summary: Enforces Node-issued capabilities and task scope for agent tools.

import { ConfigurationError } from "../shared/errors.js";

export function authorizeTool(toolName, context = {}) {
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

// Keeps coder discovery and edits out of documentation regardless of a stale ticket allowlist.
export function isCoderBlockedPath(path, context = {}) {
  return context.agent_identity?.role === "coder" && typeof path === "string" && (path === "docs" || path.startsWith("docs/"));
}

// Checks a project path against the file and directory scope granted to the agent.
export function isAgentPathAllowed(path, context = {}) {
  if (isCoderBlockedPath(path, context)) return false;
  const files = context.allowed_file_paths ?? context.allowedFilePaths;
  const prefixes = context.allowed_prefixes ?? context.allowedPrefixes;
  if (!Array.isArray(files) && !Array.isArray(prefixes)) return true;
  return (Array.isArray(files) && files.includes(path)) || (Array.isArray(prefixes) && prefixes.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(`${prefix.replace(/\/$/, "")}/`)));
}
