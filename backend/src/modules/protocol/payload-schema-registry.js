import { createRequire } from "node:module";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);

const schemas = Object.freeze({
  "node:code_provide": require("../../../../schemas/agent/payloads/node-code-provide.schema.json"),
  "node:usage_query": require("../../../../schemas/agent/payloads/node-usage-query.schema.json"),
  "node:task": require("../../../../schemas/agent/request.schema.json"),
  "agent:code_needed": require("../../../../schemas/agent/payloads/agent-code-needed.schema.json"),
  "agent:submit_code_response": require("../../../../schemas/agent/payloads/agent-code-response.schema.json"),
  "agent:code_response": require("../../../../schemas/agent/payloads/agent-code-response.schema.json"),
  "agent:usage_needed": require("../../../../schemas/agent/payloads/agent-usage-needed.schema.json"),
  "agent:no_wiring_needed": require("../../../../schemas/agent/payloads/agent-no-wiring-needed.schema.json"),
  "agent:completed": require("../../../../schemas/agent/payloads/agent-completed.schema.json"),
  "agent:continue": require("../../../../schemas/agent/payloads/agent-continue.schema.json")
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
