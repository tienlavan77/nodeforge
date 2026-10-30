// Exercises Node-bound engineering authority, immutable scope and explicit locked-tool behavior before provider cutover.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindEngineeringTools } from "../../src/tools/engineering-tool-binding.js";
import { ENGINEERING_TOOL_NAMES, CODER_TOOL_NAMES } from "../../src/tools/engineering-tool-catalog.js";

// Creates an issued ticket fixture; no owner conversation permissions or ledger are included.
function fixture(projectRoot = process.cwd()) {
  const calls = [];
  const context = { task_id: "TICKET", execution_id: "EXECUTION", project_root: projectRoot, agent_identity: { agent_id: "CODER", role: "coder", provider: "claude" },
    capabilities: [...ENGINEERING_TOOL_NAMES, "run_test", "check_test", "report_done", "respond_to_review"],
    allowed_file_paths: ["backend/allowed.js", "backend/other.js", "docs/guide.md", "workflows/agents/coder/README.md"], allowed_prefixes: [], changed_paths: [],
    execution_context: { approved_baseline: { file_checksums: { "backend/allowed.js": null } } } };
  const registry = Object.fromEntries(["read_file", "read_lines", "write_diff", "edit_diff", "delete_file", "move_file", "run_test", "check_test", "report_done", "respond_to_review", "commit_changes", "push_commit"].map((name) => [name, { execute: async (input, issued) => { calls.push({ name, input, issued }); return { task_id: issued.task_id }; } }]));
  return { calls, context, bound: bindEngineeringTools({ registry, context }) };
}

// Coder can request a supported environment without passing host paths or
// changing its issued role, command scope, or service capabilities.
test("Coder run_check accepts the typed runner request and rejects provisioning arguments", async () => {
  const { context } = fixture();
  const calls = [];
  const binding = bindEngineeringTools({ context, registry: { run_check: { execute: async input => { calls.push(input); return { status: "passed" }; } } } });
  const input = { type: "test", command: "node --test backend/tests/example.test.js", environment: "filesystem_namespace" };
  await binding.registry.run_check.execute(input);
  assert.deepEqual(calls, [input]);
  for (const patch of [{ environment: "sudo" }, { socket_path: "/host.sock" }, { environment: { command: "mount" } }])
    await assert.rejects(binding.registry.run_check.execute({ ...input, ...patch }), { code: "TOOL_INPUT_INVALID" });
  assert.equal(calls.length, 1);
});

test("caller cannot replace Node identity, capabilities, root, baseline or ticket context", async () => {
  const { bound, calls, context } = fixture();
  context.task_id = "OTHER";
  context.allowed_file_paths.push("ui/unapproved.js");
  context.execution_context.approved_baseline.file_checksums["ui/unapproved.js"] = null;
  await bound.registry.read_lines.execute({ path: "backend/allowed.js", start_line: 1, end_line: 2 }, { task_id: "FORGED", project_root: "/", agent_identity: { role: "system_engineer" } });
  assert.equal(calls[0].issued.task_id, "TICKET");
  assert.equal(calls[0].issued.agent_identity.role, "coder");
  assert.equal(calls[0].issued.project_root, process.cwd());
  await bound.registry.write_diff.execute({ path: "ui/unapproved.js", before_checksum: null, content: "// allowed" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].issued.task_id, "TICKET");
});

test("canonical schema rejects authority fields and wrong types before dispatch", async () => {
  const { bound, calls } = fixture();
  await assert.rejects(bound.registry.read_lines.execute({ path: "backend/allowed.js", start_line: "1", end_line: 2 }), { code: "TOOL_INPUT_INVALID" });
  await assert.rejects(bound.registry.write_diff.execute({ path: "backend/allowed.js", before_checksum: null, content: "x", capabilities: ["push_commit"] }), { code: "TOOL_INPUT_INVALID" });
  assert.equal(calls.length, 0);
});

test("project-wide mutation is independent of the immutable evidence manifest", async () => {
  const { bound, calls } = fixture();
  await bound.registry.write_diff.execute({ path: "backend/other.js", before_checksum: null, content: "// summary" });
  await bound.registry.write_diff.execute({ path: "backend/allowed.js", before_checksum: null, content: "// summary" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].issued.owner_changed_paths, undefined);
  assert.equal(calls[0].issued.conversation_id, undefined);
});

test("Coder reads and writes project documents while Git metadata and traversal remain denied", async () => {
  const { bound, calls } = fixture();
  await bound.registry.read_lines.execute({ path: "docs/guide.md", start_line: 1, end_line: 2 });
  for (const path of [".git/config", "../outside.js", "backend/../outside.js"]) {
    await assert.rejects(bound.registry.read_lines.execute({ path, start_line: 1, end_line: 2 }));
  }
  await bound.registry.write_diff.execute({ path: "workflows/agents/coder/README.md", before_checksum: null, content: "// updated guidance" });
  assert.equal(calls.length, 2);
});

test("symlink components cannot escape an approved path", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-engineering-scope-"));
  try {
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(root, "backend"));
    const { bound, calls } = fixture(root);
    await assert.rejects(bound.registry.read_lines.execute({ path: "backend/allowed.js", start_line: 1, end_line: 2 }), { code: "PATH_FORBIDDEN" });
    assert.equal(calls.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing focused service and unimplemented action receipts never produce PASS, commit or push", async () => {
  const calls = [];
  const { context } = fixture();
  const bound = bindEngineeringTools({ registry: {}, context });
  for (const [name, input] of [["run_check", { type: "test", command: "node --test backend/tests/unit/x.test.js" }], ["push_commit", { commit_sha: "a".repeat(40) }]]) {
    await assert.rejects(bound.registry[name].execute(input), { code: "TOOL_LOCKED" });
    assert.equal(bound.readiness.tools.find((tool) => tool.name === name).state, "locked");
  }
  assert.equal(calls.length, 0);
});

test("Coder can read canonical source windows and commit through its scoped service", async () => {
  const { bound, calls } = fixture();
  await bound.registry.read_file.execute({ path: "backend/allowed.js", offset: 1, limit: 2 });
  await bound.registry.commit_changes.execute({ message: "scope" });
  assert.deepEqual(calls.map(({ name }) => name), ["read_file", "commit_changes"]);
});

test("Coder receives the common engineering catalog plus completion with no retired extensions", () => {
  const { bound } = fixture();
  assert.deepEqual(bound.definitions.map(({ name }) => name), CODER_TOOL_NAMES);
  assert.equal(typeof bound.registry.respond_to_review.execute, "function");
  for (const name of ["search_code", "rg_files", "rg_search", "sed_lines", "run_test", "check_test"]) {
    assert.equal(bound.registry[name], undefined);
  }
});

test("delete and move endpoints may exceed baseline paths and file budgets but stay within the project", async () => {
  const { context, calls } = fixture();
  context.execution_context.approved_baseline.mutable_file_budget = 1;
  const registry = Object.fromEntries(["delete_file", "move_file"].map((name) => [name, { execute: async (input) => { calls.push({ name, input }); return {}; } }]));
  const { registry: tools } = bindEngineeringTools({ registry, context });
  const before_checksum = `sha256:${"a".repeat(64)}`;
  await tools.move_file.execute({ from_path: "extensions/source.js", to_path: "docs/moved.js", before_checksum });
  await tools.delete_file.execute({ path: "workflows/obsolete.md", before_checksum });
  await tools.delete_file.execute({ path: "CLAUDE.md", before_checksum });
  assert.equal(calls.length, 3);
  for (const path of ["../outside.js", ".git/config"]) {
    await assert.rejects(tools.move_file.execute({ from_path: path, to_path: "docs/file.js", before_checksum }));
    await assert.rejects(tools.move_file.execute({ from_path: "extensions/source.js", to_path: path, before_checksum }));
  }
  await assert.rejects(tools.move_file.execute({ from_path: "same.js", to_path: "same.js", before_checksum }), { code: "TOOL_INPUT_INVALID" });
  assert.equal(calls.length, 3);
});
