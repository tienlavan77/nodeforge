import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../../schemas/core/common.schema.json");
const governanceRuleSchema = require("../../../../schemas/governance/governance-rule.schema.json");

export function createGovernanceRulesEngine({ validateRule = createGovernanceRuleValidator() } = {}) {
  if (typeof validateRule !== "function") throw new ConfigurationError("Governance Rule validation must be a function.");
  const rules = [];
  const rulesById = new Map();

  return Object.freeze({ registerRule, evaluate, getRules });

  function registerRule(rule) {
    validateRule(rule);
    if (rulesById.has(rule.id)) throw new ConfigurationError(`Governance Rule already exists: ${rule.id}.`);
    const stored = Object.freeze(structuredClone(rule));
    rules.push(stored);
    rulesById.set(stored.id, stored);
    return structuredClone(stored);
  }

  function evaluate(context) {
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      throw new ConfigurationError("Governance Rule evaluation requires an object context.");
    }
    const outcomes = rules.map((rule) => Object.freeze({
      rule_id: rule.id,
      enforcement: rule.enforcement,
      severity: rule.severity,
      passed: rule.enabled !== false ? matches(rule.condition, context) : true
    }));
    const denied = outcomes.some((outcome) => !outcome.passed && outcome.enforcement === "blocking");
    return Object.freeze({ decision: denied ? "DENY" : "ALLOW", outcomes: Object.freeze(outcomes) });
  }

  function getRules() {
    return rules.map((rule) => structuredClone(rule));
  }
}

function createGovernanceRuleValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(governanceRuleSchema);
  const validate = ajv.getSchema(governanceRuleSchema.$id);
  return (rule) => {
    if (!validate(rule)) throw new ConfigurationError(`Invalid Governance Rule: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
    return true;
  };
}

function matches(condition, context) {
  if (typeof condition.required_field === "string") return resolve(condition.required_field, context) !== undefined;
  if (condition.equals && typeof condition.equals.path === "string" && Object.hasOwn(condition.equals, "value")) {
    return Object.is(resolve(condition.equals.path, context), condition.equals.value);
  }
  if (Array.isArray(condition.all)) return condition.all.every((item) => matches(item, context));
  if (Array.isArray(condition.any)) return condition.any.some((item) => matches(item, context));
  if (condition.not && typeof condition.not === "object") return !matches(condition.not, context);
  return false;
}

function resolve(path, context) {
  return path.split(".").reduce((value, segment) => (
    value && typeof value === "object" ? value[segment] : undefined
  ), context);
}
