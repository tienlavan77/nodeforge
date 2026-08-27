import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCheckRunner } from "../../src/modules/verification/check-runner.js";

const fixtureRoot = fileURLToPath(new URL("../fixtures/verification-project", import.meta.url));
const nodeCommand = JSON.stringify(process.execPath);
const eslintCommand = `${nodeCommand} ${JSON.stringify(fileURLToPath(new URL("../../node_modules/eslint/bin/eslint.js", import.meta.url)))}`;
const typeScriptCommand = `${nodeCommand} ${JSON.stringify(fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url)))}`;

for (const scenario of scenarios()) {
  test(`${scenario.kind} runner normalizes a ${scenario.expectedStatus} command result`, async () => {
    const projectRoot = await mkdtemp(join(os.tmpdir(), `nodeforge-check-${scenario.kind}-${scenario.expectedStatus}-`));
    await cp(fixtureRoot, projectRoot, { recursive: true });
    if (scenario.kind === "lint" && scenario.expectedStatus === "failed") {
      await writeFile(join(projectRoot, "cases", "lint-fail.js"), "console.log(\"credential\");\n");
    }
    const runner = createCheckRunner({ projectRoot, projectId: `PROJECT-${scenario.kind}-${scenario.expectedStatus}` });
    try {
      const [result] = await runner.run(plan(scenario.kind, scenario.command));

      assert.equal(result.kind, scenario.kind);
      assert.equal(result.status, scenario.expectedStatus);
      assert.equal(result.exit_code === 0, scenario.expectedStatus === "passed");
      assert.equal(result.command, scenario.command);
      assert.equal(typeof result.duration_ms, "number");
      assert.deepEqual(result.diagnostics, scenario.diagnostics);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
}

function scenarios() {
  return [
    { kind: "build", expectedStatus: "passed", command: `${nodeCommand} scripts/build-pass.js`, diagnostics: [] },
    { kind: "build", expectedStatus: "failed", command: `${nodeCommand} scripts/build-fail.js`, diagnostics: [{ severity: "error", message: "Fixture build failed", file: "cases/build-fail.js", line: 3, column: 5, rule_id: "BUILD001" }] },
    { kind: "lint", expectedStatus: "passed", command: `${eslintCommand} cases/lint-pass.js`, diagnostics: [] },
    { kind: "lint", expectedStatus: "failed", command: `${eslintCommand} cases/lint-fail.js`, diagnostics: [{ severity: "error", message: "Unexpected console statement", file: "cases/lint-fail.js", line: 1, column: 1, rule_id: "no-console" }] },
    { kind: "typecheck", expectedStatus: "passed", command: `${typeScriptCommand} --project tsconfig-pass.json`, diagnostics: [] },
    { kind: "typecheck", expectedStatus: "failed", command: `${typeScriptCommand} --project tsconfig-fail.json`, diagnostics: [{ severity: "error", message: "Type 'string' is not assignable to type 'number'.", file: "cases/type-fail.ts", line: 1, column: 7, rule_id: "TS2322" }] }
  ];
}

function plan(type, command) {
  return { commit_id: "NF-062", levels: ["focused"], checks: [{ type, command }] };
}

test("emits command and command_result around a real check", async () => {
  const events = [];
  const projectRoot = await mkdtemp(join(os.tmpdir(), "nodeforge-check-events-"));
  try {
    const runner = createCheckRunner({ projectRoot, projectId: "PROJECT-events" });
    const [result] = await runner.run(plan("build", `${nodeCommand} -e "process.exit(0)"`), { taskId: "TASK-events", eventSink: (event) => events.push(event) });
    assert.equal(result.status, "passed");
    assert.deepEqual(events.map(({ event_type }) => event_type), ["node.command", "node.command_result"]);
    assert.equal(events[0].task_id, "TASK-events");
    assert.equal(events[0].payload.conversation_id, "CONV-TASK-events");
    assert.equal(events[1].payload.conversation_id, "CONV-TASK-events");
    assert.equal(events[1].payload.command_id, events[0].payload.command_id);
    assert.equal(events[1].payload.success, true);
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});
