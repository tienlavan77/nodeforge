import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const require = createRequire(import.meta.url);
const ruleset = require("../../rules/forge-sprint-delivery.rules.json");
const commonSchema = require("../../schemas/core/common.schema.json");
const workflowRuleSchema = require("../../schemas/project/workflow-rule.schema.json");
const rulesetSchema = require("../../schemas/project/workflow-ruleset.schema.json");
const builderEvidenceSchema = require("../../schemas/project/builder-evidence.schema.json");
const validEvidence = require("../../schemas/examples/builder-evidence.json");
const invalidEvidence = require("../../schemas/examples/builder-evidence-invalid.json");

test("WF-003 maps implementation evidence to Nodeforge records", () => {
  const wf003 = ruleset.rules.find(({ id }) => id === "WF-003");

  assert.deepEqual(wf003.condition.artifacts, ["roadmap.commit", "project.task", "project.builder_evidence"]);
  assert.equal(wf003.severity, "high");
  assert.equal(wf003.enforcement, "blocking");
  assert.equal(wf003.trigger, "commit.handoff");
  assert.equal(JSON.stringify(wf003).includes("builder-report.md"), false);
});

test("the mapped ruleset and evidence contract validate", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(workflowRuleSchema).addSchema(rulesetSchema).addSchema(builderEvidenceSchema);

  const validateRuleset = ajv.getSchema(rulesetSchema.$id);
  assert.equal(validateRuleset(ruleset), true, ajv.errorsText(validateRuleset.errors));

  const validateEvidence = ajv.getSchema(builderEvidenceSchema.$id);
  assert.equal(validateEvidence(validEvidence), true, ajv.errorsText(validateEvidence.errors));
  assert.equal(validateEvidence(invalidEvidence), false);
});

test("missing Builder evidence cannot satisfy WF-003", () => {
  const wf003 = ruleset.rules.find(({ id }) => id === "WF-003");
  const availableRecords = new Set(["roadmap.commit", "project.task"]);

  assert.equal(wf003.condition.artifacts.includes("project.builder_evidence"), true);
  assert.equal(wf003.condition.artifacts.every((artifact) => availableRecords.has(artifact)), false);
});
