import test from "node:test";
import assert from "node:assert/strict";
import { createTestService } from "../../src/application/test-service.js";

// Immutable archive baseline classification: stale contracts (Supervisor dispatch, Watcher scope, Sprint Leader candidates), missing tracked fixtures (Forge layout snapshots, glossary miner), and runtime defects (project preferences, protocol storage export). Each category is covered by its focused unit test in the Node-owned verification plan.

test("TestService runs checks through the orchestrator and publishes result", async () => {
  const calls = []; const events = [];
  const service = createTestService({ projectRoot: "/tmp/project", verificationOrchestrator: { run: async (plan) => { calls.push(plan); return { status: "passed" }; } }, publisher: { publish: (event) => events.push(event) } });
  const result = await service.runLint({ commitId: "COMMIT-1" });
  assert.equal(result.status, "passed");
  assert.equal(calls[0].checks[0].type, "lint");
  assert.equal(events.at(-1).type, "verification.result");
});

test("runTests uses the unit-test baseline when callers provide no levels", async () => {
  const calls = [];
  const service = createTestService({ projectRoot: "/tmp/project", verificationOrchestrator: { run: async (plan) => { calls.push(plan); return { status: "passed" }; } } });
  await service.runTests({ commitId: "COMMIT-1", levels: [] });
  assert.equal(calls[0].checks[0].type, "test");
});

test("TestService runs schema validation without a live project root", async () => {
  const calls = [];
  const service = createTestService({ verificationOrchestrator: { run: async (plan) => { calls.push(plan); return { status: "passed" }; } } });
  const result = await service.runSchemaValidation({ commitId: "ARCHIVE-COMMIT" });
  assert.equal(result.status, "passed");
  assert.equal(calls[0].checks[0].type, "schema_validation");
});

test("TestService runs archived verification without a live project root", async () => {
  const service = createTestService({ verificationOrchestrator: { run: async () => ({ status: "passed" }) } });
  const result = await service.runTests({ commitId: "ARCHIVE-COMMIT" });
  assert.equal(result.status, "passed");
});

test("TestService rejects a blank optional project root", () => {
  assert.throws(
    () => createTestService({ projectRoot: "   ", verificationOrchestrator: { run: async () => ({ status: "passed" }) } }),
    /project root must be a non-empty string/
  );
});

test("startTests uses the unit-test baseline when callers provide empty levels", async () => {
  const calls = [];
  const service = createTestService({
    verificationOrchestrator: { run: async (plan) => { calls.push(plan); return { status: "passed" }; } }
  });
  const job = service.startTests({ commitId: "ARCHIVE-COMMIT", levels: [] });
  await settle();
  assert.equal(job.status, "running");
  assert.equal(calls[0].checks[0].type, "test");
});

const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

test("startTests returns a job_id immediately and getTestResult reports running then passed", async () => {
  const service = createTestService({
    projectRoot: "/tmp/project",
    verificationOrchestrator: { run: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return { status: "passed", checks: [] }; } }
  });
  const started = service.startTests({ commitId: "COMMIT-1", taskId: "TASK-1" });
  assert.match(started.job_id, /^TEST-JOB-\d+$/);
  assert.equal(started.status, "running");
  const running = service.getTestResult({ jobId: started.job_id, taskId: "TASK-1" });
  assert.equal(running.status, "running");
  assert.ok(Number.isFinite(running.elapsed_ms));
  await settle();
  const finished = service.getTestResult({ jobId: started.job_id, taskId: "TASK-1" });
  assert.equal(finished.status, "passed");
  assert.equal(finished.result.status, "passed");
  assert.ok(Number.isFinite(finished.duration_ms));
});

test("startTests captures orchestrator failure as a failed job with error code and message", async () => {
  const service = createTestService({
    projectRoot: "/tmp/project",
    verificationOrchestrator: { run: async () => { throw Object.assign(new Error("suite exploded"), { code: "TEST_EXECUTION_FAILED" }); } }
  });
  const started = service.startTests({ commitId: "COMMIT-1", taskId: "TASK-1" });
  await settle();
  const finished = service.getTestResult({ jobId: started.job_id, taskId: "TASK-1" });
  assert.equal(finished.status, "failed");
  assert.equal(finished.error.code, "test_execution_failed");
  assert.equal(finished.error.message, "suite exploded");
});

test("startTests reports TEST_TIMEOUT through getTestResult when the job deadline expires", async () => {
  const service = createTestService({
    projectRoot: "/tmp/project",
    jobTimeoutMs: 10,
    verificationOrchestrator: { run: () => new Promise(() => {}) }
  });
  const started = service.startTests({ commitId: "COMMIT-1", taskId: "TASK-1" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const finished = service.getTestResult({ jobId: started.job_id, taskId: "TASK-1" });
  assert.equal(finished.status, "failed");
  assert.equal(finished.error.code, "test_timeout");
});

test("normalizeError preserves string-error compatibility and is retryable", async () => {
  const { normalizeError } = await import("../../src/application/test-service.js");
  const fromString = normalizeError("plain failure");
  assert.equal(fromString.code, "test_execution_failed");
  assert.equal(fromString.retryable, true);
  assert.ok(fromString.message.includes("plain failure"));
});

test("normalizeError redacts secrets, URLs, stack traces and preserves requestId", async () => {
  const { normalizeError } = await import("../../src/application/test-service.js");
  const raw = "oops https://example.com/hook token=secret123\n  at foo (/a/b.js:1:1)\nstack trace: boom {\"raw\":123}";
  const out = normalizeError({ code: "TEST_EXECUTION_FAILED", message: raw, requestId: "REQ-1" });
  assert.ok(!out.message.includes("https://"));
  assert.ok(out.message.includes("[REDACTED_URL]"));
  assert.ok(!out.message.includes("secret123"));
  assert.ok(out.retryable === true);
  assert.equal(out.requestId, "REQ-1");
  assert.deepEqual(Object.keys(out).sort(), ["code", "message", "requestId", "retryable", "scope"]);
  // raw JSON truncation
  const longJson = JSON.stringify({ a: "x".repeat(400) });
  const out2 = normalizeError({ code: "TEST_EXECUTION_FAILED", message: longJson });
  assert.ok(out2.message.length <= 280);
});

test("normalizeError marks non-retryable codes as not retryable", async () => {
  const { normalizeError } = await import("../../src/application/test-service.js");
  for (const code of ["INPUT_INVALID", "TEST_JOB_NOT_FOUND", "TEST_JOB_FORBIDDEN", "CONFIGURATION_ERROR"]) {
    const out = normalizeError({ code, message: "bad" });
    assert.equal(out.retryable, false, code);
  }
  const retryable = normalizeError({ code: "TEST_TIMEOUT", message: "timeout" });
  assert.equal(retryable.retryable, true);
});

test("getTestResult rejects unknown jobs and jobs from another task", async () => {
  const service = createTestService({ projectRoot: "/tmp/project", verificationOrchestrator: { run: async () => ({ status: "passed" }) } });
  const started = service.startTests({ commitId: "COMMIT-1", taskId: "TASK-1" });
  assert.throws(() => service.getTestResult({ jobId: "TEST-JOB-999" }), (error) => error.code === "TEST_JOB_NOT_FOUND");
  assert.throws(() => service.getTestResult({ jobId: started.job_id, taskId: "TASK-2" }), (error) => error.code === "TEST_JOB_FORBIDDEN");
  assert.throws(() => service.getTestResult({ jobId: "  " }), (error) => error.code === "INPUT_INVALID");
});
