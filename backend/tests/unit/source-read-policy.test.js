// Verifies that every shared Forge Read caller must use discovered symbols for code,
// while Markdown retains bounded line reads without needing a code graph.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createSourceReadTool } from "../../src/tools/discovery/source-read.js";
import { authorizeTool } from "../../src/tools/governance/tool-authorization.js";
import { createReadFileTool } from "../../src/tools/governance/agent-lifecycle-tools.js";

test("authorizeTool invokes the child read-only enforcement gate", () => {
  let calledWith;
  const context = { task_id: "child-task", capabilities: ["read_file"], assertToolAllowed: (toolName) => { calledWith = toolName; if (toolName !== "read_file") throw Object.assign(new Error("forbidden"), { code: "SUBAGENT_TOOL_FORBIDDEN" }); } };
  assert.equal(authorizeTool("read_file", context), true);
  assert.equal(calledWith, "read_file");
  assert.throws(() => authorizeTool("edit_diff", { ...context, capabilities: ["edit_diff"] }), { code: "SUBAGENT_TOOL_FORBIDDEN" });
});

// Checks runtime enforcement, receipt freshness and isolation with the real shared tools.
test("code requires prior metadata and symbols; Markdown permits line windows", async () => {
  let content = "export function answer() { return 42; }\n";
  const fileService = { readForIndex: async () => ({ content,
    sha256: `sha256:${createHash("sha256").update(content).digest("hex")}` }) };
  const read = createSourceReadTool({ fileService, projectRoot: process.cwd() });
  const metadata = createReadFileTool({ fileService });
  for (const role of ["system_engineer", "architecture_manager", "coder", "reviewer", "sprint_leader"]) {
    const context = { agent_identity: { role }, execution_id: role };
    const file_path = "backend/example.js";
    await assert.rejects(read.execute({ file_path, start_line: 1, end_line: 1 }, context), /Code line windows are forbidden/);
    await assert.rejects(read.execute({ file_path, symbol: "answer" }, context), /requires current read_file metadata/);
    await metadata.execute({ path: file_path }, { ...context });
    assert.match((await read.execute({ file_path, symbol: "answer" }, { ...context })).content, /return 42/);
    await assert.rejects(read.execute({ file_path, symbol: "answer" }, { ...context, execution_id: "other" }), /requires current read_file metadata/);
    const document = await read.execute({ file_path: "docs/example.md", start_line: 1, end_line: 1 }, context);
    assert.equal(document.start_line, 1);
  }
  const context = { agent_identity: { role: "system_engineer" } };
  await metadata.execute({ path: "backend/example.js" }, context);
  content = "export function answer() { return 43; }\n";
  await assert.rejects(read.execute({ file_path: "backend/example.js", symbol: "answer" }, context), /requires current read_file metadata/);
});

// Ensures a large symbol is delivered completely while adjacent source stays undisclosed.
test("symbol reads do not mutate frozen file results or observed receipts", async () => {
  const content = "export function answer() { return 42; }\n";
  const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const fileService = { readForIndex: async () => Object.freeze({ content, sha256 }) };
  const context = { agent_identity: { role: "system_engineer" }, execution_id: "frozen-execution" };
  const metadata = createReadFileTool({ fileService });
  await metadata.execute({ path: "backend/frozen.js" }, context);
  context.observed_files = Object.freeze(context.observed_files.map((file) => Object.freeze(file)));
  const read = createSourceReadTool({ fileService, projectRoot: process.cwd() });

  const result = await read.execute({ file_path: "backend/frozen.js", symbol: "answer" }, context);

  assert.match(result.content, /return 42/);
  assert.equal(result.sha256, sha256);
  assert.equal(Object.isFrozen(context.observed_files), false);
  assert.equal(Object.isFrozen(context.observed_files[0]), false);
  assert.deepEqual(context.observed_files[0].symbols_read, ["answer"]);
});

test("symbol reads exceed 80 lines without returning neighboring code", async () => {
  const content = ["const before = 'outside';", "export function large() {",
    ...Array.from({ length: 100 }, (_, index) => `  const value${index} = ${index};`),
    "  return value99;", "}", "const after = 'outside';"].join("\n");
  const fileService = { readForIndex: async () => ({ content,
    sha256: `sha256:${createHash("sha256").update(content).digest("hex")}` }) };
  const context = { agent_identity: { role: "system_engineer" } };
  await createReadFileTool({ fileService }).execute({ path: "backend/large.js" }, context);
  const read = createSourceReadTool({ fileService, projectRoot: process.cwd() });
  const result = await read.execute({ file_path: "backend/large.js", symbol: "large" }, context);
  assert.equal(result.start_line, 2);
  assert.equal(result.end_line, 104);
  assert.equal(result.content.split("\n").length, 103);
  assert.match(result.content, /return value99/);
  assert.doesNotMatch(result.content, /outside/);
  await assert.rejects(read.execute({ file_path: "docs/example.md", start_line: 1, end_line: 81 }, context), /at most 80 lines/);
});
