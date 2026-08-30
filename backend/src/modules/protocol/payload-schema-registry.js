import { createRequire } from "node:module";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);

const schemas = Object.freeze({
  "agent:code_needed": require("../../../../schemas/agent/tools/agent-code-needed.schema.json"),
  "agent:submit_code_response": require("../../../../schemas/agent/tools/agent-code-response.schema.json"),
  "agent:code_response": require("../../../../schemas/agent/tools/agent-code-response.schema.json"),
  "agent:usage_needed": require("../../../../schemas/agent/tools/agent-usage-needed.schema.json"),
  "agent:no_wiring_needed": require("../../../../schemas/agent/tools/agent-no-wiring-needed.schema.json"),
  "agent:completed": require("../../../../schemas/agent/tools/agent-completed.schema.json"),
  "agent:continue": require("../../../../schemas/agent/tools/agent-continue.schema.json")
});

export const payloadSchemaRegistry = schemas;

export function getPayloadSchema(role, type) {
  const key = `${role}:${type}`;
  const schema = schemas[key];
  if (!schema) throw new ConfigurationError(`Unsupported payload schema: ${key}.`);
  return schema;
}

export function hasPayloadSchema(role, type) {
  return Boolean(schemas[`${role}:${type}`]);
}
