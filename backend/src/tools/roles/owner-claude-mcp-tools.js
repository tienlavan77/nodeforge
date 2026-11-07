// Exposes governed owner conversation tools to Claude Agent SDK as an in-process MCP server.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Adapts the same Forge definitions used by other providers to Claude MCP tools.
export function createOwnerClaudeMcpTools({ definitions, registry, context }) {
  const tools = definitions.map((definition) => tool(
    definition.name,
    definition.description,
    z.fromJSONSchema(claudeToolInputSchema(definition.input_schema)).shape,
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

// Keeps Forge path validation in the service while avoiding gateway-incompatible regex lookaheads in Claude tool declarations.
export function claudeToolInputSchema(schema) {
  const input = structuredClone(schema);
  // Conditional selectors remain enforced by Forge; MCP requires an object field shape.
  delete input.oneOf;
  for (const prop of Object.values(input?.properties ?? {})) {
    if (typeof prop?.pattern === "string" && prop.pattern.includes("(?!")) {
      delete prop.pattern;
      prop.description = `${prop.description ? `${prop.description} ` : ""}Use a project-relative path without parent-directory segments.`;
    }
    if (typeof prop?.items?.pattern === "string" && prop.items.pattern.includes("(?!")) {
      delete prop.items.pattern;
      prop.items.description = `${prop.items.description ? `${prop.items.description} ` : ""}Use a project-relative path without parent-directory segments.`;
    }
  }
  return input;
}
