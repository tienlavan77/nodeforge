import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProtocolStorage, protocolStorageDefaults } from "../../src/infrastructure/storage/protocol-storage.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

test("Protocol Storage requires a File Service", () => {
  assert.throws(() => createProtocolStorage(), /requires a File Service/);
});

test("Protocol Storage uses the runtime default root and exposes the planned API", () => {
  const service = { readFile() {}, atomicCreate() {} };
  const storage = createProtocolStorage({ projectRoot: "/project", fileService: service });
  assert.equal(storage.root, "/project/.forge/runtime/protocol-storage");
  assert.deepEqual(protocolStorageDefaults, { root: ".forge/runtime/protocol-storage" });
  assert.equal(typeof storage.save, "function");
  assert.equal(typeof storage.get, "function");
  assert.equal(typeof storage.exists, "function");
  assert.equal(typeof storage.list, "function");
});

test("Protocol Storage rejects unsafe roots", () => {
  const service = { readFile() {}, atomicCreate() {} };
  assert.throws(() => createProtocolStorage({ projectRoot: "/project", fileService: service, root: "../outside" }), /safe relative path/);
  assert.throws(() => createProtocolStorage({ projectRoot: "/project", fileService: service, root: "/tmp/storage" }), /safe relative path/);
});

test("Protocol Storage resolves configured root from environment with explicit option precedence", () => {
  const service = { readFile() {}, atomicCreate() {} };
  const previous = process.env.FORGE_PROTOCOL_STORAGE_ROOT;
  process.env.FORGE_PROTOCOL_STORAGE_ROOT = ".forge/runtime/custom-protocol";
  try {
    const fromEnv = createProtocolStorage({ projectRoot: "/project", fileService: service });
    assert.equal(fromEnv.root, "/project/.forge/runtime/custom-protocol");
    const explicit = createProtocolStorage({ projectRoot: "/project", fileService: service, root: ".forge/runtime/explicit" });
    assert.equal(explicit.root, "/project/.forge/runtime/explicit");
  } finally {
    if (previous === undefined) delete process.env.FORGE_PROTOCOL_STORAGE_ROOT;
    else process.env.FORGE_PROTOCOL_STORAGE_ROOT = previous;
  }
});

test("Protocol Storage accepts canonical refs and rejects traversal or malformed refs", () => {
  const service = { readFile() {}, atomicCreate() {} };
  const storage = createProtocolStorage({ projectRoot: "/project", fileService: service });
  assert.equal(storage.normalizeRef("task/FORGE-NOTIFY-004/round_1/request"), "task/FORGE-NOTIFY-004/round_1/request");
  for (const ref of ["../secret", "/absolute", "task/x/round_1\\request", "task/x/round_0/request", "task/x/round_1/other", "task/x/round_1/request/", "task//round_1/request", "task/x/round_1/request\0x"]) {
    assert.throws(() => storage.normalizeRef(ref), (error) => error.code === "STORAGE_INVALID_REF");
  }
});

test("Protocol Storage serializes JSON deterministically", () => {
  const service = { readFile() {}, atomicCreate() {} };
  const storage = createProtocolStorage({ projectRoot: "/project", fileService: service });
  assert.equal(storage.serialize({ b: 2, a: { d: 4, c: 3 }, list: [{ z: 1, y: 0 }] }), '{"a":{"c":3,"d":4},"b":2,"list":[{"y":0,"z":1}]}\n');
  assert.equal(storage.serialize({ list: [2, 1], value: "x" }), '{"list":[2,1],"value":"x"}\n');
  const circular = {}; circular.self = circular;
  assert.throws(() => storage.serialize(circular), (error) => error.code === "STORAGE_SERIALIZATION_ERROR");
  assert.throws(() => storage.serialize({ value: undefined }), (error) => error.code === "STORAGE_SERIALIZATION_ERROR");
});

test("Protocol Storage computes SHA-256 over exact serialized bytes and creates metadata", () => {
  const service = { readFile() {}, atomicCreate() {} };
  const storage = createProtocolStorage({ projectRoot: "/project", fileService: service });
  const serialized = storage.serialize({ b: 2, a: 1 });
  assert.equal(storage.checksum(serialized), "e8d38819d39f705646bfb643368eca78f7db476c16471dbc33b941b27326410d");
  const metadata = storage.createMetadata("task/TASK-1/round_1/request", serialized, "forge-envelope");
  assert.deepEqual(Object.keys(metadata).sort(), ["bytes", "created_at", "ref", "schema_id", "sha256"].sort());
  assert.equal(metadata.ref, "task/TASK-1/round_1/request");
  assert.equal(metadata.bytes, Buffer.byteLength(serialized));
  assert.match(metadata.created_at, /^2026-/);
});

test("Protocol Storage saves through File Service and is idempotent by checksum", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-storage-"));
  const files = createFileService({ projectRoot: root });
  const storage = createProtocolStorage({ projectRoot: root, fileService: files });
  const ref = "task/TASK-1/round_1/request";
  const first = await storage.save(ref, { b: 2, a: 1 }, { schemaId: "forge-envelope" });
  const second = await storage.save(ref, { a: 1, b: 2 }, { schemaId: "forge-envelope" });
  assert.equal(first.metadata.sha256, second.metadata.sha256);
  await assert.rejects(() => storage.save(ref, { a: 9 }), (error) => error.code === "STORAGE_CONFLICT");
});

test("Protocol Storage lists complete refs for a task in round order", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-storage-"));
  const files = createFileService({ projectRoot: root });
  const storage = createProtocolStorage({ projectRoot: root, fileService: files });
  await storage.save("task/TASK-LIST/round_2/response", { round: 2 });
  await storage.save("task/TASK-LIST/round_1/request", { round: 1 });
  await storage.save("task/OTHER/round_1/request", { other: true });
  assert.deepEqual(await storage.list("TASK-LIST"), [
    "task/TASK-LIST/round_1/request",
    "task/TASK-LIST/round_2/response"
  ]);
  await assert.rejects(() => storage.list("../unsafe"), (error) => error.code === "STORAGE_INVALID_TASK_ID");
});

test("Protocol Storage list rejects incomplete records", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-storage-"));
  const files = createFileService({ projectRoot: root });
  const storage = createProtocolStorage({ projectRoot: root, fileService: files });
  await files.atomicCreate({ path: ".forge/runtime/protocol-storage/task/TASK-INCOMPLETE/round_1/request.json", content: "{}\n" });
  assert.deepEqual(await storage.list("TASK-INCOMPLETE"), []);
});

test("Protocol Storage get verifies persisted checksum and reports missing metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-storage-"));
  const files = createFileService({ projectRoot: root });
  const storage = createProtocolStorage({ projectRoot: root, fileService: files });
  const ref = "task/TASK-GET/round_1/response";
  const saved = await storage.save(ref, { answer: "ok" });
  const loaded = await storage.get(ref);
  assert.deepEqual(loaded.data, { answer: "ok" });
  assert.equal(loaded.metadata.sha256, saved.metadata.sha256);

  await files.atomicWrite({ path: ".forge/runtime/protocol-storage/task/TASK-GET/round_1/response.json", content: '{"answer":"tampered"}\n', replace: true });
  await assert.rejects(() => storage.get(ref), (error) => error.code === "STORAGE_CHECKSUM_MISMATCH");
  await files.deleteFile({ path: ".forge/runtime/protocol-storage/task/TASK-GET/round_1/response.meta.json" });
  await assert.rejects(() => storage.get(ref), (error) => error.code === "STORAGE_METADATA_MISSING");
});

test("Protocol Storage get reports missing data and malformed JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-storage-"));
  const files = createFileService({ projectRoot: root });
  const storage = createProtocolStorage({ projectRoot: root, fileService: files });
  const ref = "task/TASK-MISSING/round_1/request";
  await assert.rejects(() => storage.get(ref), (error) => error.code === "STORAGE_NOT_FOUND");
  await files.atomicCreate({ path: ".forge/runtime/protocol-storage/task/TASK-MISSING/round_1/request.json", content: "not-json\n" });
  const invalidSerialized = "not-json\n";
  await files.atomicCreate({
    path: ".forge/runtime/protocol-storage/task/TASK-MISSING/round_1/request.meta.json",
    content: storage.serialize(storage.createMetadata(ref, invalidSerialized))
  });
  await assert.rejects(() => storage.get(ref), (error) => error.code === "STORAGE_DATA_INVALID");
});

test("Protocol Storage exists requires both data and metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-storage-"));
  const files = createFileService({ projectRoot: root });
  const storage = createProtocolStorage({ projectRoot: root, fileService: files });
  const ref = "task/TASK-EXISTS/round_1/request";
  assert.equal(await storage.exists(ref), false);
  await storage.save(ref, { ok: true });
  assert.equal(await storage.exists(ref), true);
  await files.deleteFile({ path: ".forge/runtime/protocol-storage/task/TASK-EXISTS/round_1/request.meta.json" });
  assert.equal(await storage.exists(ref), false);
  await assert.rejects(() => storage.exists("../unsafe"), (error) => error.code === "STORAGE_INVALID_REF");
});

test("Protocol Storage rejects metadata that does not match its schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-storage-"));
  const files = createFileService({ projectRoot: root });
  const storage = createProtocolStorage({ projectRoot: root, fileService: files });
  const ref = "task/TASK-META/round_1/request";
  await files.atomicCreate({ path: ".forge/runtime/protocol-storage/task/TASK-META/round_1/request.json", content: "{}\n" });
  await files.atomicCreate({ path: ".forge/runtime/protocol-storage/task/TASK-META/round_1/request.meta.json", content: '{"ref":"wrong","sha256":"bad","bytes":-1,"created_at":"bad"}\n' });
  await assert.rejects(() => storage.get(ref), (error) => error.code === "STORAGE_METADATA_INVALID");
});

test("Protocol Storage serializes concurrent saves per ref", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-storage-"));
  const files = createFileService({ projectRoot: root });
  const storage = createProtocolStorage({ projectRoot: root, fileService: files });
  const ref = "task/TASK-RACE/round_1/request";
  const results = await Promise.all([
    storage.save(ref, { value: 1 }),
    storage.save(ref, { value: 1 }),
    storage.save(ref, { value: 1 })
  ]);
  assert.deepEqual(results.map((result) => result.data), [{ value: 1 }, { value: 1 }, { value: 1 }]);
  await assert.rejects(() => storage.save(ref, { value: 2 }), (error) => error.code === "STORAGE_CONFLICT");
});

test("Protocol Storage cleans data when metadata creation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-storage-"));
  const base = createFileService({ projectRoot: root });
  const files = {
    ...base,
    atomicCreate: async ({ path, content }) => {
      if (path.endsWith(".meta.json")) {
        const error = new Error("metadata unavailable");
        error.code = "EIO";
        throw error;
      }
      return base.atomicCreate({ path, content });
    }
  };
  const storage = createProtocolStorage({ projectRoot: root, fileService: files });
  const ref = "task/TASK-CLEANUP/round_1/request";
  await assert.rejects(() => storage.save(ref, { value: true }), (error) => error.code === "EIO");
  await assert.rejects(() => storage.get(ref), (error) => error.code === "STORAGE_NOT_FOUND");
  assert.deepEqual(await readdir(join(root, ".forge/runtime/protocol-storage/task/TASK-CLEANUP/round_1")), []);
});
