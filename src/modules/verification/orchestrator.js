import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";
import { createCheckRunner } from "./check-runner.js";
import { createTestRunner, createVerificationPlanValidator } from "./runner.js";

const require = createRequire(import.meta.url);
const verificationResultSchema = require("../../../schemas/verification/verification-result.schema.json");
const CHECK_TYPES = ["test", "build", "lint", "typecheck"];
const RESULT_KEYS = { test: "tests", build: "build", lint: "lint", typecheck: "typecheck" };

export function createVerificationResultValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(verificationResultSchema);

  return (result) => {
    if (!validate(result)) {
      throw new ConfigurationError(`Invalid verification result: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    }
    return true;
  };
}

export function createVerificationOrchestrator({
  testRunner,
  checkRunner,
  projectRoot,
  projectId,
  createRunId = () => `VERIFY-RUN-${randomUUID()}`,
  clock = () => new Date(),
  validatePlan = createVerificationPlanValidator(),
  validateResult = createVerificationResultValidator()
} = {}) {
  if (testRunner === undefined && (typeof projectRoot !== "string" || typeof projectId !== "string")) {
    throw new ConfigurationError("Verification orchestration requires runners or a project root and project_id.");
  }
  if (typeof createRunId !== "function" || typeof clock !== "function") {
    throw new ConfigurationError("Verification orchestrator dependencies must be functions.");
  }

  const resolvedTestRunner = testRunner ?? createTestRunner({ projectRoot, projectId });
  const resolvedCheckRunner = checkRunner ?? createCheckRunner({ projectRoot, projectId });
  if (!resolvedTestRunner || typeof resolvedTestRunner.run !== "function" || !resolvedCheckRunner || typeof resolvedCheckRunner.run !== "function") {
    throw new ConfigurationError("Verification orchestrator requires test and check runners.");
  }

  return Object.freeze({
    async run(plan, options = {}) {
      validatePlan(plan);
      const runId = options.runId ?? createRunId();
      const [testResults, checkResults] = await Promise.all([
        resolvedTestRunner.run(plan, options),
        resolvedCheckRunner.run(plan, options)
      ]);
      const results = [...testResults, ...checkResults];
      const result = {
        commit_id: plan.commit_id,
        run_id: runId,
        evaluated_at: clock().toISOString(),
        status: overallStatus(results),
        ready_for_review: results.length > 0 && results.every(({ status }) => status === "passed")
      };

      for (const type of CHECK_TYPES) {
        const typeResults = results.filter((entry) => entry.kind === type || (type === "test" && entry.tests !== undefined));
        result[RESULT_KEYS[type]] = gateStatus(typeResults);
      }
      // Keep the gate explicit: scope is passed only when every requested check passed.
      result.scope = result.ready_for_review ? "passed" : result.status;
      validateResult(result);
      return Object.freeze(result);
    }
  });
}

function gateStatus(results) {
  if (results.length === 0) return "not_applicable";
  if (results.some(({ status }) => status === "failed")) return "failed";
  if (results.some(({ status }) => status === "timeout" || status === "cancelled")) return "failed";
  if (results.every(({ status }) => status === "passed")) return "passed";
  if (results.every(({ status }) => status === "skipped")) return "skipped";
  return "failed";
}

function overallStatus(results) {
  if (results.length === 0) return "not_applicable";
  const statuses = results.map(({ status }) => status);
  if (statuses.every((status) => status === "passed")) return "passed";
  if (statuses.every((status) => status === "skipped")) return "skipped";
  return "failed";
}
