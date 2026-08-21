import { randomUUID } from "node:crypto";

import { ConfigurationError } from "../../shared/errors.js";

export function createDeadLetterQueue({ createId = () => `DLQ-${randomUUID()}`, clock = () => new Date() } = {}) {
  if (typeof createId !== "function" || typeof clock !== "function") throw new ConfigurationError("Dead Letter Queue dependencies must be functions.");
  const records = [];

  return Object.freeze({ enqueue, getAll, getByType, size, dequeue, drain, purge });

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

  function dequeue(id) {
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return undefined;
    return cloneRecord(records.splice(index, 1)[0]);
  }

  function drain() {
    const drained = records.splice(0, records.length);
    return drained.map(cloneRecord);
  }

  function purge(beforeTimestamp) {
    if (typeof beforeTimestamp !== "string" || Number.isNaN(Date.parse(beforeTimestamp))) throw new ConfigurationError("DLQ purge requires a valid timestamp.");
    const retained = [];
    const removed = [];
    for (const record of records) (record.timestamp < beforeTimestamp ? removed : retained).push(record);
    records.splice(0, records.length, ...retained);
    return removed.map(cloneRecord);
  }
}

function cloneRecord(record) {
  return { ...record, payload: clone(record.payload) };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
