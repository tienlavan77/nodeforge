import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const inputSchema = require("../../../schemas/agent/agent-tool.schema.json");

// Provider-neutral definition; adapters translate the wrapper shape as needed.
export const agentToolDefinition = Object.freeze({
  name: "agent_tool",
  description: "Request guarded context only when necessary, then MUST submit one main/test file. Never finish a coding task with prose alone.",
  input_schema: inputSchema
});
