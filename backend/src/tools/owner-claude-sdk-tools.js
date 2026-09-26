// Exposes role-approved owner conversation tools to Claude through a Forge MCP server.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Builds one in-process MCP server from the same definitions and registry used by other SDKs.
export function createOwnerClaudeSdkTools(forgeTools) {
  const definitions = forgeTools?.definitions ?? [];
  const registry = forgeTools?.registry ?? {};
  const tools = definitions.filter((definition) => typeof registry[definition.name]?.execute === "function")
    .map((definition) => tool(definition.name, definition.description, z.fromJSONSchema(definition.input_schema).shape, async (input) => {
      try {
        const result = await registry[definition.name].execute(input, forgeTools.context);
        return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error_code: error.code ?? "TOOL_EXECUTION_FAILED", message: error.message }) }] };
      }
    }));
  return {
    server: createSdkMcpServer({ name: "forge", version: "1.0.0", tools, alwaysLoad: true }),
    allowedTools: definitions.filter((definition) => typeof registry[definition.name]?.execute === "function")
      .map((definition) => `mcp__forge__${definition.name}`)
  };
}
