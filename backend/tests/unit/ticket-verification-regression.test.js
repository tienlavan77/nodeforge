// Guards conservative baseline attribution against incomplete output, transient failures, and missing criterion mappings.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { regressionFailureIdentity } from "../../src/modules/supervisor/ticket-verification-regression.js";
import { buildTicketVerificationPlan } from "../../src/modules/supervisor/ticket-verification-plan.js";

test("only complete deterministic test failure evidence can identify a pre-existing regression", () => {
  const command = { test_paths: ["sample.test.js"] };
  const events = [{ type: "failure", name: "a behavior", error: { message: "expected 2 got 1", code: "ERR_ASSERTION" } },
    { type: "summary", failed: 1, cancelled: 0 }];
  const output = { exit_code: 1, stdout_redacted: events.map((event) => JSON.stringify(event)).join("\n"), stderr_redacted: "" };
  assert.match(regressionFailureIdentity(command, output, "/tmp/candidate"), /^sha256:/);
  for (const incomplete of [
    { ...output, exit_code: null }, { ...output, exit_code: 0 },
    { ...output, stdout_redacted: JSON.stringify(events[0]) },
    { ...output, stdout_redacted: `${output.stdout_redacted}\ntruncated` },
    { ...output, stdout_redacted: output.stdout_redacted.replace('"cancelled":0', '"cancelled":1') },
    { ...output, stderr_redacted: "ENOSPC" }, { ...output, stderr_redacted: "503 overloaded" }
  ]) assert.equal(regressionFailureIdentity(command, incomplete, "/tmp/candidate"), null);
});

test("ticket plan never expands through shared imports and retains explicit release suites", async () => {
  const root = await mkdtemp(join(tmpdir(), "nf-verification-scope-"));
  try {
    for (const path of ["backend/src", "backend/tests/unit", "ui/nextjs/tests"]) await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, "backend/src/shared.js"), "export const value = 1;");
    await writeFile(join(root, "backend/tests/unit/ticket.test.js"), "// ticket test");
    await writeFile(join(root, "backend/tests/unit/related.test.js"), "import '../../src/shared.js';");
    await writeFile(join(root, "backend/tests/unit/unrelated.test.js"), "// unrelated test");
    const plan = [{ kind: "test", test_path: "backend/tests/unit/ticket.test.js", criterion_ids: ["AC-1"] }];
    const commands = await buildTicketVerificationPlan(["backend/src/shared.js"], root, { verificationPlan: plan });
    const primary = commands.find((command) => command.kind === "backend_tests" && command.scope === "ticket");
    assert.deepEqual(primary.test_paths, [plan[0].test_path]);
    assert.deepEqual(primary.criterion_ids, ["AC-1"]);
    assert(!commands.some(command => command.argv.includes("backend/tests/unit/related.test.js")));
    await assert.rejects(buildTicketVerificationPlan(["backend/src/shared.js"], root), { code: "VERIFY_TEST_SCOPE_EMPTY" });
    const changed = await buildTicketVerificationPlan(["backend/src/shared.js", "backend/tests/unit/related.test.js"], root, { verificationPlan: plan });
    assert.deepEqual(changed.find(command => command.kind === "backend_tests").test_paths, ["backend/tests/unit/related.test.js", plan[0].test_path]);
    assert(!commands.some((command) => command.argv.includes("backend/tests/unit/unrelated.test.js")));
    const mandatory = await buildTicketVerificationPlan(["backend/src/shared.js"], root, { verificationPlan: [...plan, { kind: "schema_validation", criterion_ids: ["AC-2"] }] });
    assert.equal(mandatory.find((command) => command.kind === "schema_validation").scope, "ticket");
    const release = await buildTicketVerificationPlan(["backend/src/shared.js"], root, { fullBackend: true });
    assert(!release.some((command) => command.kind === "backend_tests" && command.scope === "regression"));
    assert(release.find((command) => command.kind === "backend_tests").test_paths.includes("backend/tests/unit/unrelated.test.js"));
    await writeFile(join(root, "ui/nextjs/tests/ticket.test.js"), "// UI test");
    await writeFile(join(root, "ui/nextjs/tests/shared.test.js"), "import '../component.jsx';");
    await writeFile(join(root, "ui/nextjs/tests/changed.test.mjs"), "// Changed ticket test");
    const ui = await buildTicketVerificationPlan(["ui/nextjs/component.jsx", "ui/nextjs/tests/changed.test.mjs"], root, { verificationPlan: [{ kind: "test", test_path: "ui/nextjs/tests/ticket.test.js", criterion_ids: ["AC-1"] }, { kind: "build", criterion_ids: ["AC-2"] }] });
    assert.deepEqual(ui.find((command) => command.kind === "test").test_paths, ["ui/nextjs/tests/changed.test.mjs", "ui/nextjs/tests/ticket.test.js"]);
    assert.equal(ui.find((command) => command.kind === "build").scope, "ticket");
  } finally { await rm(root, { recursive: true, force: true }); }
});
