import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCollectorWorker } from "../../src/modules/supervisor/collector-worker.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

test("collector parses porcelain output and checksums changed files", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-"));
  const fileService = createFileService({ projectRoot: root });
  await fileService.writeFile({ path: "src/a.js", content: "const a=1;\n" });
  await fileService.writeFile({ path: "src/new.js", content: "const b=2;\n" });
  const gitService = { status: async () => " M src/a.js\n?? src/new.js\n" };
  const worker = createCollectorWorker({ fileService, gitService });
  const result = await worker.collect({ task_id: "TASK-1", supervisor_id: "SUP-1", request_id: "REQ-1", correlation_id: "CORR-1", attempt: 1 });
  assert.deepEqual(result.changed_paths.sort(), ["src/a.js", "src/new.js"]);
  assert.match(result.checksums["src/a.js"], /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.empty, false);
});

test("collector reports an empty changeset when the tree is clean", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-empty-"));
  const fileService = createFileService({ projectRoot: root });
  const gitService = { status: async () => "" };
  const worker = createCollectorWorker({ fileService, gitService });
  const result = await worker.collect({ task_id: "TASK-1" });
  assert.deepEqual(result.changed_paths, []);
  assert.equal(result.empty, true);
});

test("collector returns null checksum for deleted files", async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-deleted-"));
  const fileService = createFileService({ projectRoot: root });
  const gitService = { status: async () => " D src/gone.js\n" };
  const worker = createCollectorWorker({ fileService, gitService });
  const result = await worker.collect({ task_id: "TASK-1" });
  assert.deepEqual(result.changed_paths, ["src/gone.js"]);
  assert.equal(result.checksums["src/gone.js"], null);
});

test("verification worker checks the collected changeset", async () => {
  const { createVerificationWorker } = await import("../../src/modules/supervisor/verification-worker.js");
  const worker = createVerificationWorker({ verify: async ({ path }) => ({ passed: path !== "src/bad.js" }) });
  const result = await worker.verifyChangeset({ changed_paths: ["src/good.js", "src/bad.js"], checksums: { "src/good.js": "sha256:aaa", "src/bad.js": "sha256:bbb" } });
  assert.equal(result.status, "failed");
  assert.equal(result.passed_paths.length, 1);
  assert.equal(result.failed_paths.length, 1);
  const passing = await worker.verifyChangeset({ changed_paths: ["src/good.js"], checksums: { "src/good.js": "sha256:aaa" } });
  assert.equal(passing.status, "passed");
});
