import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTestRunner } from "../../src/modules/verification/runner.js";

const projectRoot = fileURLToPath(new URL("../fixtures/verification-project", import.meta.url));
const nodeCommand = JSON.stringify(process.execPath);

test("runs a passing project test command and normalizes a schema-valid test result", async () => {
  const runner = createTestRunner({ projectRoot, projectId: "PROJECT-verification-pass" });
  const [result] = await runner.run(plan(`${nodeCommand} --test cases/pass-case.js`), { taskId: "TASK-verification-pass" });

  assert.equal(result.status, "passed");
  assert.equal(result.exit_code, 0);
  assert.equal(result.scope, "targeted");
  assert.deepEqual(result.tests, { total: 1, passed: 1, failed: 0, skipped: 0 });
  assert.deepEqual(result.failures, []);
  assert.equal(result.task_id, "TASK-verification-pass");
});

test("runs a failing project test command and captures normalized failure evidence", async () => {
  const runner = createTestRunner({ projectRoot, projectId: "PROJECT-verification-fail" });
  const [result] = await runner.run(plan(`${nodeCommand} --test cases/fail-case.js`));

  assert.equal(result.status, "failed");
  assert.notEqual(result.exit_code, 0);
  assert.deepEqual(result.tests, { total: 1, passed: 0, failed: 1, skipped: 0 });
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].name, "rejects an invalid credential");
  assert.match(result.failures[0].file, /fail-case\.js$/);
  assert.equal(result.failures[0].line, 4);
  assert.match(result.failures[0].message, /Expected values to be strictly equal/);
  assert.deepEqual(result.metadata.failure_locations, [{
    name: "rejects an invalid credential",
    file: "cases/fail-case.js",
    line: 4,
    column: 1
  }]);
});

test("emits command and command_result around a project test", async () => {
  const events = [];
  const runner = createTestRunner({ projectRoot, projectId: "PROJECT-verification-events" });
  const [result] = await runner.run(plan(`${nodeCommand} --test cases/pass-case.js`), { taskId: "TASK-verification-events", eventSink: (event) => events.push(event) });
  assert.equal(result.status, "passed");
  assert.deepEqual(events.map(({ event_type }) => event_type), ["node.command", "node.command_result"]);
  assert.equal(events[0].payload.phase, "runTests");
  assert.equal(events[0].task_id, "TASK-verification-events");
  assert.equal(events[0].payload.conversation_id, "CONV-TASK-verification-events");
  assert.equal(events[1].payload.conversation_id, "CONV-TASK-verification-events");
  assert.equal(events[1].payload.command_id, events[0].payload.command_id);
});

function plan(command) {
  return {
    commit_id: "NF-061",
    levels: ["focused"],
    checks: [{ type: "test", command }]
  };
}
