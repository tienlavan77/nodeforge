// Exposes governed owner conversation tools to Claude Agent SDK as an in-process MCP server.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Adapts the same Forge definitions used by other providers to Claude MCP tools.
export function createOwnerClaudeMcpTools({ definitions, registry, context }) {
  const tools = definitions.map((definition) => tool(
    definition.name,
    definition.description,
    z.fromJSONSchema(definition.input_schema).shape,
    async (input) => {
      try {
        const result = await registry[definition.name].execute(input, context);
        return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error_code: error.code ?? "TOOL_EXECUTION_FAILED", message: error.message }) }] };
      }
    }
  ));
  return { mcpServers: { forge: createSdkMcpServer({ name: "forge", version: "1.0.0", tools, alwaysLoad: true }) }, allowedTools: definitions.map(({ name }) => `mcp__forge__${name}`) };
}
