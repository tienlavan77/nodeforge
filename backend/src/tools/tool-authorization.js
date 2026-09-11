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
