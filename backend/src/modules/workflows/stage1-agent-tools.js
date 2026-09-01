import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const schema = require("../../../../schemas/agent/response-openai.schema.json");

// Stage-1 uses explicit response tools; the legacy agent_tool wrapper is not sent.
export const stage1AgentTools = Object.freeze(
  (schema.tools ?? []).filter(({ name }) => ["code_needed", "submit_code_response", "usage_needed", "no_wiring_needed"].includes(name))
);
