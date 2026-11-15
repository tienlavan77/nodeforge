// Business purpose: proves independent project processes cannot overwrite evidence attempts.
// Technical description: releases six forked writers through one IPC barrier, then checks
// the durable JSON from a fresh reader for every receipt, source attempt and completion.
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";

test("cross-process evidence transactions preserve every attempt and worker completion", { timeout: 60000 }, async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "evidence-process-"));
  const projectId = "concurrent-evidence";
  const children = [];
  try {
    for (let index = 0; index < 6; index++) {
      const child = fork(new URL("./subagent-evidence-process-worker.js", import.meta.url), [projectRoot, projectId, "worker-" + index], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      children.push(child);
    }
    await Promise.all(children.map(async (child) => {
      const [message] = await once(child, "message");
      assert.equal(message.ready, true);
    }));
    const completions = children.map(async (child) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const [code] = await once(child, "exit");
      assert.equal(code, 0, stderr);
    });
    for (const child of children) child.send({ go: true });
    await Promise.all(completions);
    const file = join(projectRoot, ".forge/runtime/nf/evidence-stores", projectId, "system_engineer.json");
    const persisted = JSON.parse(await readFile(file, "utf8"));
    const shared = persisted.evidence.find((entry) => entry.path === "shared.js");
    assert.equal(new Set(shared.attempts.map((attempt) => attempt.attempt_id)).size, 180);
    assert.equal(new Set(shared.symbols_read).size, 6);
    for (let worker = 0; worker < 6; worker++) {
      for (let index = 0; index < 15; index++) {
        assert.ok(shared.attempts.some((attempt) => attempt.attempt_id === "worker-" + worker + ":" + index));
        assert.ok(shared.attempts.some((attempt) => attempt.attempt_id === "worker-" + worker + ":" + index + ":source"));
      }
      assert.ok(persisted.evidence.some((entry) => entry.path === "worker-" + worker + ".js"));
      const completion = persisted.workers.find((entry) => entry.worker_id === "worker-" + worker);
      assert.equal(completion.status, "completed");
      assert.equal(completion.result.durable, true);
      assert.equal(completion.result.summary, "worker-" + worker);
    }
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
