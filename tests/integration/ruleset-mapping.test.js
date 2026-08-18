import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import picomatch from "picomatch";

const require = createRequire(import.meta.url);
const ruleset = require("../../rules/forge-sprint-delivery.rules.json");
const commonSchema = require("../../schemas/core/common.schema.json");
const workflowRuleSchema = require("../../schemas/project/workflow-rule.schema.json");
const rulesetSchema = require("../../schemas/project/workflow-ruleset.schema.json");

test("maps WF-002, WF-003, WF-005, WF-006, and WF-007 to Nodeforge records", () => {
  const rule = (id) => ruleset.rules.find((entry) => entry.id === id);
  assert.deepEqual(rule("WF-002").condition.requires, ["task.workflow_state", "roadmap.commit"]);
  assert.deepEqual(rule("WF-003").condition.artifacts, ["roadmap.commit", "project.task", "project.builder_evidence"]);
  assert.equal(rule("WF-005").condition.allowlist_field, "roadmap.commit.allowed_change_areas");
  assert.deepEqual(rule("WF-006").condition.requires, ["results.review-result", "results.review-result.findings", "verification-result.ready_for_review"]);
  assert.deepEqual(rule("WF-007").condition.required_fields, ["verification-run.level", "verification-run.status", "verification-run.checks[].command", "verification-run.checks[].result_ref"]);
});

test("validates the complete mapped ruleset and leaves no legacy artifact dependency", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(workflowRuleSchema).addSchema(rulesetSchema);
  const validate = ajv.getSchema(rulesetSchema.$id);
  assert.equal(validate(ruleset), true, ajv.errorsText(validate.errors));
  assert.equal(JSON.stringify(ruleset).match(/status\.json|COMMIT\.md|builder-report\.md|review\.md/g), null);
});

test("allows only paths inside the active commit allowlist", () => {
  const commit = { id: "NF-065c", allowed_change_areas: ["src/modules/rules/**", "tests/integration/ruleset-*.test.js"] };
  const matches = picomatch(commit.allowed_change_areas, { dot: true });

  assert.equal(matches("src/modules/rules/permission-evaluator.js"), true);
  assert.equal(matches("tests/integration/ruleset-mapping.test.js"), true);
  assert.equal(matches("src/modules/context/context.js"), false);
  assert.equal(matches("review.md"), false);
});
