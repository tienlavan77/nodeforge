import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const inputSchema = require("../../../schemas/agent/agent-tool.schema.json");

// Provider-neutral definition; adapters translate the wrapper shape as needed.
export const agentToolDefinition = Object.freeze({
  name: "agent_tool",
  description: "Request guarded context or submit one main/test file for the current task.",
  input_schema: inputSchema
});
