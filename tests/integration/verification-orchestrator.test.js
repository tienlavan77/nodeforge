import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createVerificationOrchestrator } from "../../src/modules/verification/orchestrator.js";

const projectRoot = fileURLToPath(new URL("../fixtures/verification-project", import.meta.url));
const nodeCommand = JSON.stringify(process.execPath);
const eslintCommand = `${nodeCommand} ${JSON.stringify(fileURLToPath(new URL("../../node_modules/eslint/bin/eslint.js", import.meta.url)))}`;
const typeScriptCommand = `${nodeCommand} ${JSON.stringify(fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url)))}`;

test("orchestrates test and build/lint/typecheck passes into a review-ready gate", async () => {
  const orchestrator = createVerificationOrchestrator({
    projectRoot,
    projectId: "PROJECT-NF-063",
    createRunId: () => "VERIFY-RUN-PASS"
  });

  const result = await orchestrator.run(fullPlan(`${nodeCommand} --test cases/pass-case.js`));

  assert.equal(result.run_id, "VERIFY-RUN-PASS");
  assert.equal(result.status, "passed");
  assert.equal(result.ready_for_review, true);
  assert.deepEqual(result, {
    commit_id: "NF-063",
    run_id: "VERIFY-RUN-PASS",
    evaluated_at: result.evaluated_at,
    status: "passed",
    scope: "passed",
    tests: "passed",
    build: "passed",
    lint: "passed",
    typecheck: "passed",
    ready_for_review: true
  });
});

test("marks the gate failed and not review-ready when one check fails", async () => {
  const orchestrator = createVerificationOrchestrator({
    projectRoot,
    projectId: "PROJECT-NF-063",
    createRunId: () => "VERIFY-RUN-FAIL"
  });

  const result = await orchestrator.run(fullPlan(`${nodeCommand} --test cases/fail-case.js`));

  assert.equal(result.status, "failed");
  assert.equal(result.ready_for_review, false);
  assert.equal(result.tests, "failed");
  assert.equal(result.build, "passed");
  assert.equal(result.lint, "passed");
  assert.equal(result.typecheck, "passed");
});

test("aggregates multiple results for the same check type", async () => {
  const multiPlan = { commit_id: "NF-063", levels: ["focused"], checks: [
    { type: "test", command: `${nodeCommand} --test cases/pass-case.js` },
    { type: "test", command: `${nodeCommand} --test cases/pass-case.js` },
    { type: "lint", command: `${eslintCommand} cases/lint-pass.js` }
  ] };
  const orchestrator = createVerificationOrchestrator({
    projectRoot,
    projectId: "PROJECT-NF-063",
    createRunId: () => "VERIFY-RUN-MULTI"
  });

  const result = await orchestrator.run(multiPlan);

  assert.equal(result.status, "passed");
  assert.equal(result.tests, "passed");
  assert.equal(result.lint, "passed");
  assert.equal(result.build, "not_applicable");
  assert.equal(result.typecheck, "not_applicable");
});

test("runs checks before tests", async () => {
  const order = [];
  const orchestrator = createVerificationOrchestrator({
    testRunner: { run: async () => { order.push("test"); return []; } },
    checkRunner: { run: async () => { order.push("check"); return []; } },
    validatePlan: () => {},
    validateResult: () => {}
  });
  await orchestrator.run({ commit_id: "NF-order", levels: ["focused"], checks: [] });
  assert.deepEqual(order, ["check", "test"]);
});

function fullPlan(testCommand) {
  return { commit_id: "NF-063", levels: ["focused"], checks: [
    { type: "test", command: testCommand },
    { type: "build", command: `${nodeCommand} scripts/build-pass.js` },
    { type: "lint", command: `${eslintCommand} cases/lint-pass.js` },
    { type: "typecheck", command: `${typeScriptCommand} --project tsconfig-pass.json` }
  ] };
}
