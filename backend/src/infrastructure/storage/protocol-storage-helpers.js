// Summary: Provides protocol-storage validation, deterministic serialization, and error helpers for durable ticket artifacts.
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const metadataSchema = require("../../../../schemas/agent/protocol-storage-metadata.schema.json");

export function createMetadataValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(metadataSchema);
}

export function protocolError(code, message) {
  const error = new ConfigurationError(message);
  error.code = code;
  return error;
}

export function storageError(code, message) {
  const error = new ConfigurationError(message);
  error.code = code;
  return error;
}

export function storageConflict(ref) {
  return storageError("STORAGE_CONFLICT", `Storage ref already contains different data: ${ref}.`);
}

export function metadataValidationError(errors, ref = "metadata") {
  const detail = errors?.length ? errors.map((error) => `${error.instancePath || "data"} ${error.message}`).join("; ") : "schema validation failed";
  return storageError("STORAGE_METADATA_INVALID", `Metadata is invalid for ${ref}: ${detail}.`);
}

export function compareRefs(left, right) {
  const round = (ref) => Number(ref.match(/\/round_(\d+)\//)?.[1] ?? 0);
  const roundDifference = round(left) - round(right);
  return roundDifference || left.localeCompare(right);
}

export function sortValue(value, seen) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || value === undefined) throw new Error("unsupported JSON value");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number");
    return value;
  }
  if (seen.has(value)) throw new Error("circular reference");
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map((item) => sortValue(item, seen));
  else if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("unsupported object type");
  else result = Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, sortValue(value[key], seen)]));
  seen.delete(value);
  return result;
}
