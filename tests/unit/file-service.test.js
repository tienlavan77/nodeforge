import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

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
