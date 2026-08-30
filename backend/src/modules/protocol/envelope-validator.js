import { createRequire } from "node:module";

import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";
import { getPayloadSchema } from "./payload-schema-registry.js";

const require = createRequire(import.meta.url);
const envelopeSchema = require("../../../../schemas/agent/envelope.schema.json");
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateShape = ajv.compile(envelopeSchema);

/**
 * Validate the common envelope first, then its role/type-specific payload.
 * State checks are deliberately optional until the workflow state machine exists.
 */
export function validateEnvelope(envelope, options = {}) {
  if (!validateShape(envelope)) {
    return invalid("INVALID_ENVELOPE", validateShape.errors);
  }

  const schemaType = payloadType(envelope.role, envelope.type);
  let payloadSchema;
  try {
    payloadSchema = getPayloadSchema(envelope.role, schemaType);
  } catch (error) {
    return invalid("UNSUPPORTED_PAYLOAD_TYPE", [{ message: error.message, keyword: "registry" }]);
  }

  const validatePayload = ajv.compile(payloadSchema);
  if (!validatePayload(envelope.payload)) {
    return invalid("INVALID_PAYLOAD", validatePayload.errors, { schema_id: payloadSchema.$id });
  }

  const stateError = validateState(envelope, options.state);
  if (stateError) return invalid("INVALID_PROTOCOL_STATE", [stateError]);

  return { valid: true, envelope, schema_id: payloadSchema.$id };
}

function payloadType(role, type) {
  if (role === "agent" && (type === "code_response" || type === "submit_code_response")) return "submit_code_response";
  return type;
}

function validateState(envelope, state) {
  if (!state) return null;
  const allowed = state.allowedTypes ?? (state.expectedType ? [state.expectedType] : null);
  if (allowed && !allowed.includes(envelope.type)) {
    return { keyword: "state", message: `Expected type ${allowed.join(" or ")}, received ${envelope.type}.` };
  }
  return null;
}

function invalid(code, errors, extra = {}) {
  return { valid: false, code, errors: structuredClone(errors ?? []), ...extra };
}

export function assertValidEnvelope(envelope, options = {}) {
  const result = validateEnvelope(envelope, options);
  if (!result.valid) throw new ConfigurationError(`${result.code}: ${formatErrors(result.errors)}`);
  return result.envelope;
}

function formatErrors(errors) {
  return errors.map((error) => error.message ?? "invalid message").join("; ");
}
