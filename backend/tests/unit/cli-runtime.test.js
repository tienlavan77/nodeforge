import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runCli } from "../../src/transport/cli/index.js";

test("routes Agent CLI commands through Runtime Service with deterministic JSON", async () => {
  const calls = [];
  const output = [];
  const runtime = {
    startTask(input) { calls.push(["startTask", input]); return { id: "SESSION-107", state: "RUNNING" }; },
    pauseSession(id) { calls.push(["pauseSession", id]); return { id, state: "PAUSED" }; },
    resumeSession(id) { calls.push(["resumeSession", id]); return { id, state: "RUNNING" }; },
    getSession(id) { calls.push(["getSession", id]); return { id, state: "RUNNING" }; }
  };
  const stdout = { write(value) { output.push(value); } };
  const stderr = { write() {} };
  const options = { runtimeService: runtime, stdout, stderr, signalEmitter: new EventEmitter() };

  assert.equal(await runCli(["run", "PROJECT-107", "TASK-107"], options), 0);
  assert.equal(await runCli(["pause", "SESSION-107"], options), 0);
  assert.equal(await runCli(["resume", "SESSION-107"], options), 0);
  assert.equal(await runCli(["session", "SESSION-107"], options), 0);
  assert.deepEqual(output, [
    '{"id":"SESSION-107","state":"RUNNING"}\n',
    '{"id":"SESSION-107","state":"PAUSED"}\n',
    '{"id":"SESSION-107","state":"RUNNING"}\n',
    '{"id":"SESSION-107","state":"RUNNING"}\n'
  ]);
  assert.deepEqual(calls, [
    ["startTask", { projectId: "PROJECT-107", taskId: "TASK-107" }], ["pauseSession", "SESSION-107"],
    ["resumeSession", "SESSION-107"], ["getSession", "SESSION-107"]
  ]);
});
