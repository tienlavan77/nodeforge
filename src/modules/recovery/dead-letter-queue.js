import { randomUUID } from "node:crypto";

import { ConfigurationError } from "../../shared/errors.js";

export function createDeadLetterQueue({ createId = () => `DLQ-${randomUUID()}`, clock = () => new Date() } = {}) {
  if (typeof createId !== "function" || typeof clock !== "function") throw new ConfigurationError("Dead Letter Queue dependencies must be functions.");
  const records = [];

  return Object.freeze({ enqueue, getAll, getByType, size });

  function enqueue(item, reason) {
    if (!item || typeof item !== "object" || typeof item.type !== "string" || item.type.length === 0) {
      throw new ConfigurationError("Dead Letter Queue items require a type.");
    }
    if (typeof reason !== "string" || reason.length === 0) throw new ConfigurationError("Dead Letter Queue items require a reason.");
    const record = Object.freeze({
      id: createId(),
      type: item.type,
      payload: clone(item.payload),
      reason,
      timestamp: clock().toISOString()
    });
    records.push(record);
    return cloneRecord(record);
  }

  function getAll() {
    return records.map(cloneRecord);
  }

  function getByType(type) {
    if (typeof type !== "string" || type.length === 0) throw new ConfigurationError("A Dead Letter Queue type is required.");
    return records.filter((record) => record.type === type).map(cloneRecord);
  }

  function size() {
    return records.length;
  }
}

function cloneRecord(record) {
  return { ...record, payload: clone(record.payload) };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
