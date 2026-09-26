import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createRoleFileService } from "../../src/infrastructure/filesystem/file-service-role-policy.js";
import { createReadFileTool, createWriteDiffTool } from "../../src/tools/agent-lifecycle-tools.js";
import { createOwnerDeleteFileTool } from "../../src/tools/owner-delete-file.js";

test("FileService guards paths and serializes writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-files-"));
  const events = [];
  const files = createFileService({ projectRoot: root, internalBus: { emit: (type, payload) => events.push({ type, payload }) } });
  await assert.rejects(() => files.writeFile({ path: "../escape.txt", content: "x" }), /unsafe/);
  await assert.rejects(() => files.writeFile({ path: ".env", content: "secret" }), /unsafe/);
  await Promise.all([files.writeFile({ path: "src/a.txt", content: "a" }), files.writeFile({ path: "src/b.txt", content: "b" })]);
  assert.equal(await readFile(join(root, "src/a.txt"), "utf8"), "a");
  assert.equal((await files.listFiles({ glob: "src/*.txt" })).length, 2);
  assert.equal(events.length, 2);
});

test("Architecture Manager reads, writes, and deletes workflows through role-scoped File Service", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-workflows-"));
  try {
    const files = createFileService({ projectRoot: root });
    const architectureFiles = createRoleFileService({ fileService: files, role: "architecture_manager", projectRoot: root });
    const coderFiles = createRoleFileService({ fileService: files, role: "coder", projectRoot: root });
    const write = createWriteDiffTool({ fileService: architectureFiles });
    const read = createReadFileTool({ fileService: architectureFiles });
    const remove = createOwnerDeleteFileTool({ fileService: architectureFiles });
    const path = "workflows/delivery.workflow.json";
    await write.execute({ path, content: '{"name":"Delivery"}\n', before_checksum: null }, {});
    const current = await read.execute({ path }, {});
    assert.match(current.sha256, /^sha256:/);
    await assert.rejects(() => remove.execute({ path, before_checksum: "sha256:stale" }), (error) => error.code === "CHECKSUM_MISMATCH");
    await assert.rejects(() => coderFiles.atomicWrite({ path, content: "{}", replace: true }), (error) => error.code === "FILE_ROLE_FORBIDDEN");
    await assert.rejects(() => coderFiles.deleteFile({ path }), (error) => error.code === "FILE_ROLE_FORBIDDEN");
    await assert.rejects(() => architectureFiles.deleteFile({ path: "docs/decision.md" }), (error) => error.code === "FILE_ROLE_FORBIDDEN");
    await symlink(join(root, ".."), join(root, "workflows", "outside"));
    await assert.rejects(() => architectureFiles.atomicWrite({ path: "workflows/outside/escape.json", content: "{}", replace: true }), (error) => error.code === "FILE_ROLE_FORBIDDEN");
    assert.deepEqual(await remove.execute({ path, before_checksum: current.sha256 }), { path, deleted: true });
    await assert.rejects(() => files.readFile({ path }), (error) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readForIndex returns source metadata and rejects ignored, secret, and binary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-files-"));
  const files = createFileService({ projectRoot: root });
  await files.writeFile({ path: "src/example.js", content: "export const value = 1;\n" });
  const indexed = await files.readForIndex({ path: "src/example.js" });
  assert.equal(indexed.language, "javascript");
  assert.equal(indexed.size_bytes, Buffer.byteLength(indexed.content));
  assert.match(indexed.sha256, /^sha256:[0-9a-f]{64}$/);
  await assert.rejects(() => files.readForIndex({ path: "src/example.js", maxBytes: 5 }), (error) => error.code === "FILE_TOO_LARGE");
  await assert.rejects(() => files.readForIndex({ path: ".env" }), /unsafe|secret|ignored/i);
  await assert.rejects(() => files.readForIndex({ path: ".next/build.js" }), /unsafe|secret|ignored/i);
  await files.writeFile({ path: "src/binary.bin", content: `ok${String.fromCharCode(0)}bad` });
  await assert.rejects(() => files.readForIndex({ path: "src/binary.bin" }), /binary/i);
});

test("FileService includes verification step details when a write is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-files-"));
  const files = createFileService({
    projectRoot: root,
    onWrite: async () => {
      const error = new Error("Verification failed for tests/example.test.js: failed");
      error.verificationResult = { breakdown: [{ kind: "test", status: "failed", exit_code: 1 }] };
      throw error;
    }
  });

  await assert.rejects(
    () => files.writeFile({ path: "tests/example.test.js", content: "test(\"x\", () => {});" }),
    /Verification failed.*test:failed \(exit 1\)/
  );
});

test("FileService accepts a normalized target directory with a trailing slash", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-files-"));
  const files = createFileService({ projectRoot: root });
  await files.writeFile({
    path: "src/example.js",
    content: "export const value = 1;\n",
    commit: { target_path: "src/example.js", target_dir: "src/", file_operation: "create" }
  });
});

test("FileService permits writes under .forge/runtime while keeping other .forge paths blocked", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-files-"));
  const files = createFileService({ projectRoot: root });
  await files.writeFile({ path: ".forge/runtime/protocol.json", content: "{}\n" });
  await files.writeFile({ path: ".forge/runtime/.lock", content: "locked\n" });
  assert.equal(await readFile(join(root, ".forge/runtime/protocol.json"), "utf8"), "{}\n");
  await assert.rejects(() => files.writeFile({ path: ".forge/config.json", content: "{}" }), /unsafe/);
});

test("FileService exposes atomicCreate and atomicWrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-files-"));
  const files = createFileService({ projectRoot: root });
  await files.atomicCreate({ path: ".forge/runtime/protocol.json", content: "{\"v\":1}\n" });
  await assert.rejects(() => files.atomicCreate({ path: ".forge/runtime/protocol.json", content: "{\"v\":2}\n" }), /already exists/i);
  await files.atomicWrite({ path: ".forge/runtime/protocol.json", content: "{\"v\":2}\n", replace: true });
  assert.equal(await readFile(join(root, ".forge/runtime/protocol.json"), "utf8"), "{\"v\":2}\n");
});

test("atomicCreate publishes through a completed temp file and cleans the temp artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-files-"));
  const files = createFileService({ projectRoot: root });
  const result = await files.atomicCreate({ path: ".forge/runtime/request.json", content: "{\"ok\":true}\n" });
  assert.equal(result.atomic, true);
  assert.equal(await readFile(join(root, ".forge/runtime/request.json"), "utf8"), "{\"ok\":true}\n");
  assert.deepEqual(await readdir(join(root, ".forge/runtime")), ["request.json"]);
});

test("atomicCreate reports a stable no-overwrite error code", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-files-"));
  const logs = [];
  const files = createFileService({ projectRoot: root, logger: { error: (...args) => logs.push(args) } });
  await files.atomicCreate({ path: ".forge/runtime/immutable.json", content: "first\n" });
  await assert.rejects(
    () => files.atomicCreate({ path: ".forge/runtime/immutable.json", content: "second\n" }),
    (error) => error.code === "FILE_ALREADY_EXISTS" && error.path === ".forge/runtime/immutable.json"
  );
  assert.equal(logs.length, 0);
});

test("appendFile serializes writes and returns byte offsets", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-files-"));
  const files = createFileService({ projectRoot: root });
  const [first, second] = await Promise.all([
    files.appendFile({ path: ".forge/runtime/nf/conversations/a.jsonl", content: "first\n" }),
    files.appendFile({ path: ".forge/runtime/nf/conversations/a.jsonl", content: "second\n" })
  ]);
  assert.equal(first.byte_offset, 0);
  assert.equal(second.byte_offset, first.byte_length);
  assert.equal(await readFile(join(root, ".forge/runtime/nf/conversations/a.jsonl"), "utf8"), "first\nsecond\n");
});

test("FileService lists and removes an empty runtime directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-empty-runtime-dir-"));
  const files = createFileService({ projectRoot: root });
  try {
    await files.atomicWrite({ path: ".forge/runtime/disposable/marker.txt", content: "x", replace: true });
    assert.ok((await files.listDirectories({ glob: ".forge/runtime/**" })).includes(".forge/runtime/disposable"));
    await files.deleteFile({ path: ".forge/runtime/disposable/marker.txt" });
    await files.removeEmptyDirectory({ path: ".forge/runtime/disposable" });
    assert.equal((await files.listDirectories({ glob: ".forge/runtime/**" })).includes(".forge/runtime/disposable"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createLock fails loudly on contention and releases cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-files-"));
  const files = createFileService({ projectRoot: root });
  const lock = await files.createLock({ path: ".forge/runtime/nf/test.lock" });
  await assert.rejects(() => files.createLock({ path: ".forge/runtime/nf/test.lock" }), (error) => error.code === "FILE_LOCK_EXISTS");
  await lock.release();
  const second = await files.createLock({ path: ".forge/runtime/nf/test.lock" });
  await second.release();
});

test("createLockSync provides the same no-overwrite contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-files-"));
  const files = createFileService({ projectRoot: root });
  const lock = files.createLockSync({ path: ".forge/runtime/nf/sync.lock" });
  assert.throws(() => files.createLockSync({ path: ".forge/runtime/nf/sync.lock" }), (error) => error.code === "FILE_LOCK_EXISTS");
  lock.release();
  const next = files.createLockSync({ path: ".forge/runtime/nf/sync.lock" });
  next.release();
});
