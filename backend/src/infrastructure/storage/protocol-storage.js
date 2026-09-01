import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const DEFAULT_ROOT = ".forge/runtime/protocol-storage";
const require = createRequire(import.meta.url);
const metadataSchema = require("../../../../schemas/agent/protocol-storage-metadata.schema.json");

/**
 * Protocol Storage facade. Serialization, checksums, and persistence policy are
 * added in subsequent steps; all filesystem access remains delegated to FileService.
 */
export function createProtocolStorage({ projectRoot = process.cwd(), fileService, root } = {}) {
  if (typeof fileService?.readFile !== "function" || typeof fileService?.atomicCreate !== "function") {
    throw new ConfigurationError("Protocol Storage requires a File Service with readFile and atomicCreate.");
  }
  if (typeof projectRoot !== "string" || !projectRoot) throw new ConfigurationError("Protocol Storage requires a project root.");
  const configuredRoot = root ?? process.env.FORGE_PROTOCOL_STORAGE_ROOT ?? DEFAULT_ROOT;
  if (typeof configuredRoot !== "string" || !configuredRoot || configuredRoot.startsWith("/") || configuredRoot.split(/[\\/]/).includes("..")) {
    throw new ConfigurationError("Protocol Storage root must be a safe relative path.");
  }

  const storageRoot = resolve(projectRoot, configuredRoot);
  const storageRootRelative = configuredRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const validateMetadata = createMetadataValidator();
  const saveLocks = new Map();
  return Object.freeze({ save, get, exists, list, root: storageRoot, normalizeRef, serialize, checksum, createMetadata });

  async function save(ref, data, { schemaId } = {}) {
    const normalizedRef = normalizeRef(ref);
    const previous = saveLocks.get(normalizedRef) || Promise.resolve();
    let release;
    const current = new Promise((resolveLock) => { release = resolveLock; });
    saveLocks.set(normalizedRef, current);
    await previous;
    try {
      return await saveUnlocked(normalizedRef, data, schemaId);
    } finally {
      release();
      if (saveLocks.get(normalizedRef) === current) saveLocks.delete(normalizedRef);
    }
  }

  async function saveUnlocked(normalizedRef, data, schemaId) {
    const serialized = serialize(data);
    const metadata = createMetadata(normalizedRef, serialized, schemaId);
    const dataPath = storagePath(normalizedRef, ".json");
    const metadataPath = storagePath(normalizedRef, ".meta.json");
    try {
      await fileService.atomicCreate({ path: dataPath, content: serialized });
    } catch (error) {
      if (error.code !== "FILE_ALREADY_EXISTS") throw error;
      const existing = await readExisting(normalizedRef, dataPath, metadataPath);
      if (existing.metadata.sha256 !== metadata.sha256) throw storageConflict(normalizedRef);
      return { ref: existing.ref, data: existing.data, metadata: existing.metadata };
    }
    try {
      await fileService.atomicCreate({ path: metadataPath, content: serialize(metadata) });
    } catch (error) {
      await fileService.deleteFile({ path: dataPath }).catch(() => {});
      if (error.code === "FILE_ALREADY_EXISTS") throw storageConflict(normalizedRef);
      throw error;
    }
    return { ref: normalizedRef, data: structuredClone(data), metadata };
  }

  async function get(ref) {
    const normalizedRef = normalizeRef(ref);
    const dataPath = storagePath(normalizedRef, ".json");
    const metadataPath = storagePath(normalizedRef, ".meta.json");
    const existing = await readExisting(normalizedRef, dataPath, metadataPath);
    const actualChecksum = checksum(existing.serialized);
    if (existing.metadata.sha256 !== actualChecksum) {
      throw storageError("STORAGE_CHECKSUM_MISMATCH", `Stored data checksum does not match metadata for ${normalizedRef}.`);
    }
    if (existing.metadata.bytes !== Buffer.byteLength(existing.serialized, "utf8")) {
      throw storageError("STORAGE_CHECKSUM_MISMATCH", `Stored data byte count does not match metadata for ${normalizedRef}.`);
    }
    return { ref: normalizedRef, data: existing.data, metadata: existing.metadata };
  }

  async function exists(ref) {
    const normalizedRef = normalizeRef(ref);
    const dataPath = storagePath(normalizedRef, ".json");
    const metadataPath = storagePath(normalizedRef, ".meta.json");
    const [dataExists, metadataExists] = await Promise.all([
      fileExists(dataPath),
      fileExists(metadataPath)
    ]);
    // A protocol record is complete only when both its content and metadata exist.
    return dataExists && metadataExists;
  }

  async function list(taskId) {
    const normalizedTaskId = normalizeTaskId(taskId);
    if (typeof fileService.listFiles !== "function") throw storageError("STORAGE_LIST_UNAVAILABLE", "Protocol Storage File Service cannot list files.");
    const prefix = `${storageRootRelative}/task/${normalizedTaskId}/`;
    const files = await fileService.listFiles({ glob: `${prefix}round_*/{request,response}{,.meta}.json` });
    const fileSet = new Set(files);
    const refs = files
      .filter((path) => path.endsWith(".json") && !path.endsWith(".meta.json"))
      .filter((path) => fileSet.has(path.replace(/\.json$/, ".meta.json")))
      .map((path) => path.slice(storageRootRelative.length + 1, -".json".length));
    refs.sort(compareRefs);
    await Promise.all(refs.map((ref) => get(ref)));
    return refs;
  }

  function normalizeRef(ref) {
    if (typeof ref !== "string" || !ref) throw protocolError("STORAGE_INVALID_REF", "Storage ref is required.");
    if (ref.includes("\0") || ref.includes("\\") || ref.startsWith("/") || ref.endsWith("/") || ref.split("/").some((part) => part === ".." || part === "." || part === "")) {
      throw protocolError("STORAGE_INVALID_REF", "Storage ref must be a safe relative path.");
    }
    if (!/^task\/[A-Za-z0-9][A-Za-z0-9._-]*\/round_[1-9][0-9]*\/(request|response)$/.test(ref)) {
      throw protocolError("STORAGE_INVALID_REF", "Storage ref must match task/<id>/round_<n>/(request|response).");
    }
    return ref;
  }

  function normalizeTaskId(taskId) {
    if (typeof taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) {
      throw protocolError("STORAGE_INVALID_TASK_ID", "Storage task_id must be a safe path segment.");
    }
    return taskId;
  }

  function serialize(value) {
    try {
      const normalized = sortValue(value, new WeakSet());
      const json = JSON.stringify(normalized);
      if (json === undefined) throw new Error("value is not JSON serializable");
      return `${json}\n`;
    } catch (error) {
      const failure = protocolError("STORAGE_SERIALIZATION_ERROR", `Unable to serialize protocol data: ${error.message}`);
      failure.cause = error;
      throw failure;
    }
  }

  function checksum(serialized) {
    if (typeof serialized !== "string") throw protocolError("STORAGE_CHECKSUM_ERROR", "Checksum input must be serialized text.");
    return createHash("sha256").update(Buffer.from(serialized, "utf8")).digest("hex");
  }

  function createMetadata(ref, serialized, schemaId) {
    const normalizedRef = normalizeRef(ref);
    if (typeof serialized !== "string") throw protocolError("STORAGE_SERIALIZATION_ERROR", "Metadata requires serialized text.");
    const metadata = { ref: normalizedRef, sha256: checksum(serialized), bytes: Buffer.byteLength(serialized, "utf8"), created_at: new Date().toISOString() };
    if (schemaId !== undefined) {
      if (typeof schemaId !== "string" || !schemaId) throw protocolError("STORAGE_METADATA_ERROR", "schema_id must be a non-empty string.");
      metadata.schema_id = schemaId;
    }
    if (!validateMetadata(metadata)) {
      throw metadataValidationError(validateMetadata.errors);
    }
    return Object.freeze(metadata);
  }

  function storagePath(ref, suffix) { return `${storageRootRelative}/${ref}${suffix}`; }

  async function readExisting(ref, dataPath, metadataPath) {
    let serialized;
    try { serialized = await fileService.readFile({ path: dataPath }); }
    catch (error) { throw error.code === "ENOENT" ? storageError("STORAGE_NOT_FOUND", `Stored data is missing for ${ref}.`) : error; }
    let metadata;
    try { metadata = JSON.parse(await fileService.readFile({ path: metadataPath })); }
    catch (error) { throw error.code === "ENOENT" ? storageError("STORAGE_METADATA_MISSING", `Metadata is missing for ${ref}.`) : error; }
    if (!validateMetadata(metadata) || metadata.ref !== ref) throw metadataValidationError(validateMetadata.errors, ref);
    let data;
    try { data = JSON.parse(serialized); }
    catch (error) {
      const failure = storageError("STORAGE_DATA_INVALID", `Stored data is not valid JSON for ${ref}.`);
      failure.cause = error;
      throw failure;
    }
    return { ref, data, metadata, serialized };
  }

  async function fileExists(path) {
    try {
      await fileService.readFile({ path });
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
}

function createMetadataValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(metadataSchema);
}

export const protocolStorageDefaults = Object.freeze({ root: DEFAULT_ROOT });

function protocolError(code, message) {
  const error = new ConfigurationError(message);
  error.code = code;
  return error;
}

function storageError(code, message) {
  const error = new ConfigurationError(message);
  error.code = code;
  return error;
}

function storageConflict(ref) { return storageError("STORAGE_CONFLICT", `Storage ref already contains different data: ${ref}.`); }

function metadataValidationError(errors, ref = "metadata") {
  const detail = errors?.length ? errors.map((error) => `${error.instancePath || "data"} ${error.message}`).join("; ") : "schema validation failed";
  return storageError("STORAGE_METADATA_INVALID", `Metadata is invalid for ${ref}: ${detail}.`);
}

function compareRefs(left, right) {
  const round = (ref) => Number(ref.match(/\/round_(\d+)\//)?.[1] ?? 0);
  const roundDifference = round(left) - round(right);
  return roundDifference || left.localeCompare(right);
}

function sortValue(value, seen) {
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
  else result = Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key], seen)]));
  seen.delete(value);
  return result;
}
