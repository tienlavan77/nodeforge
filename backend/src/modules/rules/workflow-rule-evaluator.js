import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import picomatch from "picomatch";

import { ConfigurationError } from "../../shared/errors.js";
import { createNodeEventValidator } from "../watcher/debounced-watcher.js";

const require = createRequire(import.meta.url);
const defaultRuleset = require("../../../rules/forge-sprint-delivery.rules.json");
const commonSchema = require("../../../../schemas/core/common.schema.json");
const builderEvidenceSchema = require("../../../../schemas/project/builder-evidence.schema.json");
const workflowRuleSchema = require("../../../../schemas/project/workflow-rule.schema.json");
const rulesetSchema = require("../../../../schemas/project/workflow-ruleset.schema.json");

export function createWorkflowRuleEvaluator({ ruleset = defaultRuleset, projectId, internalBus, clock = () => new Date(), createEventId = () => `EVT-${randomUUID()}`, validateEvent = createNodeEventValidator() } = {}) {
  if (typeof projectId !== "string" || projectId.length === 0 || !internalBus?.emit) {
    throw new ConfigurationError("A project_id and internal bus are required for workflow rule evaluation.");
  }
  if (typeof clock !== "function" || typeof createEventId !== "function" || typeof validateEvent !== "function") {
    throw new ConfigurationError("Workflow rule evaluator dependencies must be functions.");
  }
  createWorkflowRulesetValidator()(ruleset);
  const validateEvidence = createBuilderEvidenceValidator();

  function evaluate({ trigger, context = {} } = {}) {
    if (typeof trigger !== "string" || trigger.length === 0 || !context || typeof context !== "object") {
      throw new ConfigurationError("Workflow rule evaluation requires a trigger and context.");
    }
    return Object.freeze(ruleset.rules
      .filter((rule) => rule.enabled && rule.trigger === trigger)
      .map((rule) => Object.freeze({
        rule_id: rule.id,
        severity: rule.severity,
        enforcement: rule.enforcement,
        passed: evaluateCondition(rule.condition, context, validateEvidence),
        reason: conditionReason(rule.condition)
      })));
  }

  async function execute(request, actionFn) {
    if (typeof actionFn !== "function") throw new ConfigurationError("A workflow action must be a function.");
    const outcomes = evaluate(request);
    const failures = outcomes.filter(({ passed }) => !passed);
    for (const failure of failures) emitViolation(request.trigger, failure);
    if (failures.some(({ enforcement }) => enforcement === "blocking")) {
      return Object.freeze({ allowed: false, executed: false, outcomes });
    }
    const result = await actionFn();
    return Object.freeze({ allowed: true, executed: true, outcomes, result });
  }

  function emitViolation(trigger, failure) {
    const event = {
      event_id: createEventId(),
      type: "rules.rule_violated",
      project_id: projectId,
      timestamp: clock().toISOString(),
      payload: {
        rule_id: failure.rule_id,
        trigger,
        severity: failure.severity,
        enforcement: failure.enforcement,
        reason: failure.reason
      }
    };
    validateEvent(event);
    internalBus.emit("event", Object.freeze(event));
  }

  return Object.freeze({ evaluate, execute });
}

export function createWorkflowRulesetValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(workflowRuleSchema).addSchema(rulesetSchema);
  const validate = ajv.getSchema(rulesetSchema.$id);
  return (ruleset) => {
    if (!validate(ruleset)) {
      throw new ConfigurationError(`Invalid workflow ruleset: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    }
    return true;
  };
}

function createBuilderEvidenceValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(builderEvidenceSchema);
  return ajv.getSchema(builderEvidenceSchema.$id);
}

function evaluateCondition(condition, context, validateEvidence) {
  switch (condition.kind) {
    case "status_transition":
      return transitionMatches(condition, context.transition) && (condition.requires ?? []).every((reference) => referenceSatisfied(reference, context, validateEvidence));
    case "role_action":
      return condition.effect === "deny"
        ? context.actor !== condition.actor || context.action !== condition.action
        : context.actor === condition.actor && context.action === condition.action;
    case "artifact_requirement":
      return condition.artifacts.every((reference) => referenceSatisfied(reference, context, validateEvidence));
    case "change_area":
      return typeof context.path === "string" && Array.isArray(context.roadmap?.commit?.allowed_change_areas)
        && picomatch.isMatch(context.path, context.roadmap.commit.allowed_change_areas, { dot: true });
    case "dependency_gate":
      return Array.isArray(context.dependencies) && context.dependencies.every(({ status }) => status === condition.required_status);
    case "test_evidence":
      return testEvidenceMatches(condition, context, validateEvidence);
    case "owner_gate":
      return Array.isArray(context.owner_approvals)
        && condition.requires_owner_approval_for.every((change) => context.owner_approvals.includes(change));
    default:
      return false;
  }
}

function transitionMatches(condition, transition) {
  if (!transition || transition.from === undefined || transition.to === undefined || transition.actor === undefined) return false;
  const allowedFrom = Array.isArray(condition.from) ? condition.from : [condition.from];
  return allowedFrom.includes(transition.from) && transition.to === condition.to && condition.allowed_actors.includes(transition.actor);
}

function testEvidenceMatches(condition, context, validateEvidence) {
  const run = context.verification_run;
  if (!run || run.status !== "passed" || !Array.isArray(run.checks) || !condition.required_fields.every((reference) => referenceSatisfied(reference, context, validateEvidence))) return false;
  if (!run.checks.every((check) => check.status === "passed" && typeof check.command === "string" && typeof check.result_ref === "string" && context.results?.[check.result_ref])) return false;
  return !Array.isArray(context.change_kinds)
    || !context.change_kinds.some((change) => condition.full_test_triggers.includes(change))
    || run.level === "full";
}

function referenceSatisfied(reference, context, validateEvidence) {
  const value = resolveReference(reference, context);
  if (reference === "project.builder_evidence") return Array.isArray(value) && value.length > 0 && value.every((evidence) => validateEvidence(evidence));
  if (reference === "verification-result.ready_for_review") return value === true;
  return value !== undefined && value !== null;
}

function resolveReference(reference, context) {
  const prefixes = [
    ["roadmap.commit", context.roadmap?.commit],
    ["task", context.task],
    ["project.task", context.task],
    ["project.builder_evidence", context.builder_evidence],
    ["results.review-result", context.review_result],
    ["verification-result", context.verification_result],
    ["verification-run", context.verification_run]
  ];
  const prefix = prefixes.find(([name]) => reference === name || reference.startsWith(`${name}.`));
  if (!prefix) return undefined;
  const [name, root] = prefix;
  const suffix = reference.slice(name.length).replace(/^\./, "");
  if (!suffix) return root;
  return suffix.split(".").reduce((value, segment) => {
    if (value === undefined || value === null) return undefined;
    if (segment.endsWith("[]")) {
      const property = segment.slice(0, -2);
      const items = value[property];
      return Array.isArray(items) ? items.map((item) => item) : undefined;
    }
    if (Array.isArray(value)) return value.every((item) => item?.[segment] !== undefined) ? value.map((item) => item[segment]) : undefined;
    return value[segment];
  }, root);
}

function conditionReason(condition) {
  return `Condition ${condition.kind} was not satisfied.`;
}
