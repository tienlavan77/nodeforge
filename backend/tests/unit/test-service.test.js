import test from "node:test";
import assert from "node:assert/strict";
import { createTestService } from "../../src/application/test-service.js";

test("TestService runs checks through the orchestrator and publishes result", async () => {
  const calls = []; const events = [];
  const service = createTestService({ projectRoot: "/tmp/project", verificationOrchestrator: { run: async (plan) => { calls.push(plan); return { status: "passed" }; } }, publisher: { publish: (event) => events.push(event) } });
  const result = await service.runLint({ commitId: "COMMIT-1" });
  assert.equal(result.status, "passed");
  assert.equal(calls[0].checks[0].type, "lint");
  assert.equal(events.at(-1).type, "verification.result");
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
  assert.equal(finished.error.code, "TEST_EXECUTION_FAILED");
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
  assert.equal(finished.error.code, "TEST_TIMEOUT");
});

test("getTestResult rejects unknown jobs and jobs from another task", async () => {
  const service = createTestService({ projectRoot: "/tmp/project", verificationOrchestrator: { run: async () => ({ status: "passed" }) } });
  const started = service.startTests({ commitId: "COMMIT-1", taskId: "TASK-1" });
  assert.throws(() => service.getTestResult({ jobId: "TEST-JOB-999" }), (error) => error.code === "TEST_JOB_NOT_FOUND");
  assert.throws(() => service.getTestResult({ jobId: started.job_id, taskId: "TASK-2" }), (error) => error.code === "TEST_JOB_FORBIDDEN");
  assert.throws(() => service.getTestResult({ jobId: "  " }), (error) => error.code === "INPUT_INVALID");
});
