// Gives Claude owner roles governed Forge tools and explicitly approved built-ins.
import { ConfigurationError } from "../shared/errors.js";

// Enables the supplied Forge MCP tools and keeps native tools disabled unless explicitly allowlisted.
export function createClaudeForgeOptions({ mcpServers, allowedTools }, extra = {}) {
  if (!mcpServers?.forge || !Array.isArray(allowedTools) || allowedTools.some((name) => !name.startsWith("mcp__forge__") && name !== "WebSearch")) {
    throw new ConfigurationError("Claude Forge options require a Forge MCP server and its tool allowlist.");
  }
  return { ...extra, tools: [], mcpServers, allowedTools: [...allowedTools] };
}
