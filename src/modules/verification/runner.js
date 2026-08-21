import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";
import { createProjectCommandExecutor } from "./command-executor.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const testResultSchema = require("../../../schemas/results/test-result.schema.json");
const verificationPlanSchema = require("../../../schemas/verification/verification-plan.schema.json");

export function createTestResultValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(testResultSchema);
  const validate = ajv.getSchema(testResultSchema.$id);

  return (result) => {
    if (!validate(result)) {
      throw new ConfigurationError(`Invalid test result: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    }
    return true;
  };
}

export function createVerificationPlanValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(verificationPlanSchema);

  return (plan) => {
    if (!validate(plan)) {
      throw new ConfigurationError(`Invalid verification plan: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    }
    return true;
  };
}

export function createTestRunner({ projectRoot, projectId, spawnProcess, createId = () => `TEST-${randomUUID()}`, clock = () => new Date(), validatePlan = createVerificationPlanValidator(), validateResult = createTestResultValidator(), emitEvent = () => {} } = {}) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0 || typeof projectId !== "string" || projectId.length === 0) {
    throw new ConfigurationError("A project root and project_id are required for test execution.");
  }
  if (typeof createId !== "function" || typeof clock !== "function") {
    throw new ConfigurationError("Test runner dependencies must be functions.");
  }
  const execute = createProjectCommandExecutor({ projectRoot, spawnProcess });

  return Object.freeze({
    async run(plan, { taskId, sessionId, scope = scopeFor(plan), timeoutMs } = {}) {
      validatePlan(plan);
      if (!isScope(scope)) throw new ConfigurationError("Test result scope must be targeted, integration, full, or custom.");

      const checks = plan.checks.filter(({ type }) => type === "test");
      const results = [];
      for (const check of checks) {
        results.push(await runCheck(check, { taskId, sessionId, scope, timeoutMs }));
      }
      return Object.freeze(results);
    }
  });

  async function runCheck(check, { taskId, sessionId, scope, timeoutMs }) {
    const startedAt = clock();
    const execution = await execute(check.command, { timeoutMs: timeoutMs ?? defaultTimeout("unit_test") });
    const finishedAt = clock();
    const summary = parseTapSummary(execution.stdout);
    const status = execution.timedOut ? "timeout" : execution.exitCode === 0 ? "passed" : "failed";
    if (execution.timedOut) emitEvent({ type: "TEST_TIMEOUT", task_id: taskId, session_id: sessionId, command: check.command, timeout_ms: timeoutMs ?? defaultTimeout("unit_test") });
    const parsedFailures = status === "failed" ? parseFailures(execution.stdout, execution.stderr) : [];
    const result = {
      id: createId(),
      project_id: projectId,
      status,
      exit_code: execution.exitCode,
      command: check.command,
      scope,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      tests: summary,
      failures: parsedFailures.map(normalizeFailure),
      stdout: execution.stdout,
      stderr: execution.stderr
    };
    const failureLocations = parsedFailures.filter(({ column }) => column !== undefined).map(({ name, file, line, column }) => ({ name, file, line, column }));
    if (failureLocations.length > 0) result.metadata = { failure_locations: failureLocations };
    if (taskId !== undefined) result.task_id = taskId;
    if (sessionId !== undefined) result.session_id = sessionId;
    validateResult(result);
    return Object.freeze(result);
  }

}

function defaultTimeout(type) {
  return { build: 60000, lint: 30000, unit_test: 120000, integration: 300000 }[type] ?? 120000;
}

function scopeFor(plan) {
  if (plan?.levels?.includes("full")) return "full";
  if (plan?.levels?.includes("related")) return "integration";
  if (plan?.levels?.includes("focused")) return "targeted";
  return "custom";
}

function isScope(scope) {
  return ["targeted", "integration", "full", "custom"].includes(scope);
}

function parseTapSummary(stdout) {
  return {
    total: tapCount(stdout, "tests"),
    passed: tapCount(stdout, "pass"),
    failed: tapCount(stdout, "fail"),
    skipped: tapCount(stdout, "skipped")
  };
}

function tapCount(stdout, label) {
  return Number(new RegExp(`^[#ℹ]\\s+${label}\\s+(\\d+)\\s*$`, "m").exec(stdout)?.[1] ?? 0);
}

function parseFailures(stdout, stderr) {
  const failures = [];
  const matcher = /^not ok\s+\d+\s+-\s+(.+?)\n\s+---\n([\s\S]*?)\n\s+\.\.\.$/gm;
  for (const match of stdout.matchAll(matcher)) {
    const [, name, details] = match;
    const location = /location:\s*'?(.*?):(\d+):(\d+)'?\s*$/m.exec(details);
    const message = parseFailureMessage(details) ?? name;
    const failure = { name, message, stack: details.trim() };
    if (location) {
      failure.file = location[1];
      failure.line = Number(location[2]);
    }
    failures.push(failure);
  }
  for (const match of stdout.matchAll(/^test at (.+?):(\d+):(\d+)\n✖ (.+?)(?: \([\d.]+ms\))?$/gm)) {
    const [, file, line, column, name] = match;
    const remainder = stdout.slice(match.index + match[0].length);
    const message = firstNonEmptyLine(remainder) ?? name;
    failures.push({ name, file, line: Number(line), column: Number(column), message, stack: remainder.trim() });
  }
  const uniqueFailures = failures.filter((failure, index) => failures.findIndex(({ name, file, line }) => name === failure.name && file === failure.file && line === failure.line) === index);
  if (uniqueFailures.length === 0) {
    uniqueFailures.push({ name: "test command", message: firstNonEmptyLine(stderr) ?? firstNonEmptyLine(stdout) ?? "Test command failed." });
  }
  return uniqueFailures;
}

function normalizeFailure({ name, file, line, message, stack }) {
  const failure = { name, message };
  if (file !== undefined) failure.file = file;
  if (line !== undefined) failure.line = line;
  if (stack !== undefined) failure.stack = stack;
  return failure;
}

function parseFailureMessage(details) {
  const literal = /^\s*error:\s*\|-\s*\n([\s\S]*?)(?=^\s*[a-z_]+:|\s*$)/m.exec(details)?.[1];
  if (literal) return literal.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
  return /^\s*error:\s*(.+)$/m.exec(details)?.[1]?.trim();
}

function firstNonEmptyLine(value) {
  return value.split("\n").map((line) => line.trim()).find(Boolean);
}
