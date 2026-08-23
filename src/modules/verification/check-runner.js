import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { basename, relative, resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";
import { createProjectCommandExecutor } from "./command-executor.js";
import { createVerificationPlanValidator } from "./runner.js";

const require = createRequire(import.meta.url);
const checkResultSchema = require("../../../schemas/results/check-result.schema.json");
const commonSchema = require("../../../schemas/core/common.schema.json");
const CHECK_TYPES = new Set(["build", "lint", "typecheck"]);

export function createCheckResultValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(checkResultSchema);
  const validate = ajv.getSchema(checkResultSchema.$id);

  return (result) => {
    if (!validate(result)) {
      throw new ConfigurationError(`Invalid check result: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    }
    return true;
  };
}

export function createCheckRunner({ projectRoot, projectId, spawnProcess, createId = () => `CHECK-${randomUUID()}`, clock = () => new Date(), validatePlan = createVerificationPlanValidator(), validateResult = createCheckResultValidator(), emitEvent = () => {} } = {}) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0 || typeof projectId !== "string" || projectId.length === 0) {
    throw new ConfigurationError("A project root and project_id are required for check execution.");
  }
  if (typeof createId !== "function" || typeof clock !== "function") {
    throw new ConfigurationError("Check runner dependencies must be functions.");
  }
  const execute = createProjectCommandExecutor({ projectRoot, spawnProcess });

  return Object.freeze({
    async run(plan, { taskId, sessionId, timeoutMs, eventSink } = {}) {
      validatePlan(plan);
      const results = [];
      for (const check of plan.checks.filter(({ type }) => CHECK_TYPES.has(type))) {
        results.push(await runCheck(check, { taskId, sessionId, timeoutMs, eventSink }));
      }
      return Object.freeze(results);
    }
  });

  async function runCheck(check, { taskId, sessionId, timeoutMs, eventSink }) {
    const startedAt = clock();
    const effectiveTimeout = timeoutMs ?? defaultTimeout(check.type);
    const commandId = createId();
    emitCommand(eventSink, taskId, commandId, check.command, check.type, startedAt);
    const execution = await execute(check.command, { timeoutMs: effectiveTimeout });
    const finishedAt = clock();
    const status = execution.timedOut ? "timeout" : execution.exitCode === 0 ? "passed" : "failed";
    if (execution.timedOut) emitEvent({ type: "TEST_TIMEOUT", task_id: taskId, session_id: sessionId, command: check.command, timeout_ms: effectiveTimeout });
    const result = {
      id: createId(),
      project_id: projectId,
      kind: check.type,
      status,
      exit_code: execution.exitCode,
      command: check.command,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      diagnostics: status === "failed" ? parseDiagnostics(check.type, execution.stdout, execution.stderr) : [],
      stdout: execution.stdout,
      stderr: execution.stderr
    };
    if (taskId !== undefined) result.task_id = taskId;
    if (sessionId !== undefined) result.session_id = sessionId;
    validateResult(result);
    emitCommandResult(eventSink, taskId, commandId, execution, result, finishedAt);
    return Object.freeze(result);
  }

  function emitCommand(sink, taskId, commandId, command, phase, startedAt) {
    if (typeof sink !== "function" || typeof taskId !== "string") return;
    const phaseName = phase === "lint" ? "runLint" : phase === "build" ? "runBuildCheck" : phase === "test" ? "runTests" : undefined;
    sink({ event_type: "node.command", task_id: taskId, timestamp: startedAt.toISOString(), sequence: 1, payload: { command_id: commandId, command, ...(phaseName ? { phase: phaseName } : {}) } });
  }

  function emitCommandResult(sink, taskId, commandId, execution, result, finishedAt) {
    if (typeof sink !== "function" || typeof taskId !== "string") return;
    const errorCode = result.status === "passed" ? null : result.status === "timeout" ? "IO_ERROR" : result.kind === "lint" ? "LINT_FAILED" : result.kind === "build" ? "BUILD_FAILED" : "TEST_FAILED";
    sink({ event_type: "node.command_result", task_id: taskId, timestamp: finishedAt.toISOString(), sequence: 2, payload: { command_id: commandId, success: result.status === "passed", result: { step_name: result.kind === "lint" ? "runLint" : result.kind === "build" ? "runBuildCheck" : "runTests", success: result.status === "passed", error_code: errorCode, duration_ms: result.duration_ms }, exit_code: execution.exitCode, stdout: summarize(execution.stdout), stderr: summarize(execution.stderr) } });
  }

  function summarize(value) { return value.length > 4000 ? `${value.slice(0, 4000)}\n[output truncated]` : value; }

  function parseDiagnostics(kind, stdout, stderr) {
    const output = `${stdout}\n${stderr}`;
    const diagnostics = kind === "lint" ? parseEslint(output) : kind === "typecheck" ? parseTypeScript(output) : parseBuild(output);
    if (diagnostics.length > 0 || output.trim().length === 0) return diagnostics;
    return [{ severity: "error", message: firstNonEmptyLine(output) }];
  }

  function normalizePath(path) {
    const slashPath = path.split("\\").join("/");
    const marker = `/${basename(projectRoot)}/`;
    const markerIndex = slashPath.lastIndexOf(marker);
    if (markerIndex !== -1) return slashPath.slice(markerIndex + marker.length);
    const candidates = [resolve(process.cwd(), path), resolve(projectRoot, path)];
    const absolutePath = candidates.find((candidate) => {
      const candidateRelative = relative(projectRoot, candidate);
      return candidateRelative === "" || !candidateRelative.startsWith("..");
    }) ?? candidates[1];
    return relative(projectRoot, absolutePath).split("\\").join("/");
  }

  function parseEslint(output) {
    const diagnostics = [];
    const matcher = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/gm;
    for (const match of output.matchAll(matcher)) {
      const [, line, column, severity, message, ruleId] = match;
      const prior = output.slice(0, match.index);
      const file = prior.trimEnd().split("\n").at(-1)?.trim();
      diagnostics.push({ severity, message, ...(file ? { file: normalizePath(file) } : {}), line: Number(line), column: Number(column), rule_id: ruleId });
    }
    return diagnostics;
  }

  function parseTypeScript(output) {
    return [...output.matchAll(/^(.+)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)].map(([, file, line, column, ruleId, message]) => ({
      severity: "error",
      message,
      file: normalizePath(file),
      line: Number(line),
      column: Number(column),
      rule_id: ruleId
    }));
  }

  function parseBuild(output) {
    return [...output.matchAll(/^(.+?):(\d+):(\d+):\s*(error|warning)\s+(\S+)\s+(.+)$/gm)].map(([, file, line, column, severity, ruleId, message]) => ({
      severity,
      message,
      file: normalizePath(file),
      line: Number(line),
      column: Number(column),
      rule_id: ruleId
    }));
  }
}

function defaultTimeout(type) {
  return { build: 60000, lint: 30000, typecheck: 30000, integration: 300000 }[type] ?? 30000;
}

function firstNonEmptyLine(output) {
  return output.split("\n").map((line) => line.trim()).find(Boolean) ?? "Check command failed.";
}
