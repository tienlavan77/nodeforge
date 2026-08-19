import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const eventSchema = require("../../../schemas/core/event.schema.json");

export function createEventPublisher({ store, subscriptions, source = "node", validateEvent = createEventValidator() } = {}) {
  if (typeof store?.append !== "function" || (subscriptions !== undefined && typeof subscriptions?.publish !== "function") || typeof source !== "string" || source.length === 0 || typeof validateEvent !== "function") {
    throw new ConfigurationError("Event Publisher requires an Event Store, source, and validator.");
  }

  return Object.freeze({ publish });

  function publish(event) {
    validateEvent(event);
    const result = store.append({
      event_id: event.event_id,
      event_type: event.type,
      timestamp: event.timestamp,
      source: event.metadata?.source ?? source,
      payload: event.payload,
      metadata: { ...event.metadata ?? {}, project_id: event.project_id, ...(event.task_id ? { task_id: event.task_id } : {}) }
    });
    const delivered = result.accepted ? subscriptions?.publish(result.event) ?? 0 : 0;
    return Object.freeze({ ...result, delivered });
  }
}

export function createEventValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(eventSchema);
  const validate = ajv.getSchema(eventSchema.$id);
  return (event) => {
    if (!validate(event)) throw new ConfigurationError(`Invalid published event: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    return true;
  };
}
