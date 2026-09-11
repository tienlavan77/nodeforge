import { schema } from "./stage1-response-schema.js";

// Stage-1 uses explicit response tools; the legacy agent_tool wrapper is not sent.
export const stage1AgentTools = Object.freeze(
  (schema.tools ?? []).filter(({ name }) => ["code_needed", "planning", "submit_code_response", "patch_repair_response", "usage_needed", "no_wiring_needed"].includes(name))
);
