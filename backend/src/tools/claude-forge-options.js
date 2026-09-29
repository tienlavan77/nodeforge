// Gives every Claude and Anthropic role the same Forge-only SDK tool boundary.
import { ConfigurationError } from "../shared/errors.js";

// Enables the supplied Forge MCP tools while removing Claude's built-in tools.
export function createClaudeForgeOptions({ mcpServers, allowedTools }, extra = {}) {
  if (!mcpServers?.forge || !Array.isArray(allowedTools) || allowedTools.some((name) => !name.startsWith("mcp__forge__"))) {
    throw new ConfigurationError("Claude Forge options require a Forge MCP server and its tool allowlist.");
  }
  return { ...extra, tools: [], mcpServers, allowedTools: [...allowedTools] };
}
