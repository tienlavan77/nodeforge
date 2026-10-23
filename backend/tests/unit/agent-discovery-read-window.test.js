// Proves repository-sized source windows across live, committed, and Reviewer readers while preserving byte and Markdown contracts.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadFileTool } from "../../src/tools/agent-lifecycle-tools.js";
import { createSedLinesTool } from "../../src/tools/sed-lines.js";
import { createCommittedReviewWindow } from "../../src/modules/supervisor/committed-review-window.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/reviewer-forge-tools.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { readFileDefinition } from "../../src/tools/index.js";

// Builds predictable physical lines independently of source code budgets for boundary assertions.
function source(count) { return Array.from({ length: count }, (_, index) => `value${index + 1};`).join("\n"); }

// Isolates actual File Service and process-backed reads in a disposable project.
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-read-window-"));
  try {
    await mkdir(join(root, "backend"));
    await writeFile(join(root, "backend/example.js"), source(300));
    const fileService = createFileService({ projectRoot: root });
    await run({ root, fileService });
  } finally { await rm(root, { recursive: true, force: true }); }
}

// Exercises the public lifecycle reader's defaults, offsets, EOF, rejection codes, and unchanged document reads.
test("read_file accepts 250 source lines and rejects larger windows", async () => fixture(async ({ root, fileService }) => {
  const tool = createReadFileTool({ fileService });
  const metadata = await tool.execute({ path: "backend/example.js" });
  assert.equal(metadata.content, undefined);
  assert.match(metadata.notice, /250/);
  for (const input of [{ offset: 1 }, { offset: 1, limit: 250 }, { offset: 25, limit: 250 }]) {
    const result = await tool.execute({ path: "backend/example.js", ...input });
    assert.equal(result.content.split("\n").length, 250);
    assert.equal(result.limit, 250);
    assert.equal(result.truncated, true);
  }
  const eof = await tool.execute({ path: "backend/example.js", offset: 299, limit: 250 });
  assert.equal(eof.content, "value299;\nvalue300;");
  assert.equal(eof.truncated, false);
  await assert.rejects(tool.execute({ path: "backend/example.js", offset: 301 }), { code: "OFFSET_OUT_OF_RANGE" });
  for (const limit of [251, 500]) await assert.rejects(tool.execute({ path: "backend/example.js", offset: 1, limit }), { code: "INPUT_INVALID" });
  await writeFile(join(root, "backend/example.md"), source(300));
  const markdown = await tool.execute({ path: "backend/example.md", symbol: "ignored" });
  assert.equal(markdown.content, source(250));
  assert.equal(markdown.truncated, true);
  assert.equal((await tool.execute({ path: "backend/example.md", offset: 251, limit: 250 })).content, source(300).split("\n").slice(250).join("\n"));
  await assert.rejects(tool.execute({ path: "backend/example.md", limit: 251 }), { code: "INPUT_INVALID" });
}));

// Ensures both live aliases and retained-commit reads share the boundary without changing their error-code identities.
test("live and committed line readers accept 250 and reject 251 or more", async () => fixture(async ({ root, fileService }) => {
  for (const toolName of ["read_lines", "sed_lines"]) {
    const readers = [createSedLinesTool({ projectRoot: root, fileService, toolName, logger: { emit() {} } }), createCommittedReviewWindow(fileService, toolName)];
    for (const tool of readers) {
      const context = { task_id: "TASK", capabilities: [toolName], allowed_prefixes: ["backend/"] };
      const result = await tool.execute({ path: "backend/example.js", start_line: 25, end_line: 274 }, context);
      assert.equal(result.exit_code, 0);
      assert.equal(result.stdout.trimEnd().split("\n").length, 250);
      assert.ok(result.stdout.startsWith("value25;\n"));
      const eof = await tool.execute({ path: "backend/example.js", start_line: 299, end_line: 548 }, context);
      assert.equal(eof.stdout.trimEnd(), "value299;\nvalue300;");
      for (const end_line of [251, 500]) await assert.rejects(tool.execute({ path: "backend/example.js", start_line: 1, end_line }, context), { code: tool === readers[0] || toolName === "sed_lines" ? "SED_LINES_INPUT_INVALID" : "READ_LINES_INPUT_INVALID" });
    }
  }
}));

// Verifies Reviewer wrappers admit complete source windows while retaining their stricter result byte budget.
test("Reviewer readers enforce 250-line windows and independent output ceilings", async () => fixture(async ({ root, fileService }) => {
  const tools = createReviewerForgeTools({ fileService, projectRoot: root, job: { task_id: "TASK", correlation_id: "CORR", request_id: "REQ", payload: {} }, reviewer: { agent_id: "REVIEWER", provider: "codex" } });
  const result = await tools.registry.read_file.execute({ path: "backend/example.js", offset: 1, limit: 250 });
  assert.equal(result.content, source(250));
  await assert.rejects(tools.registry.read_file.execute({ path: "backend/example.js", offset: 1 }), { code: "REVIEW_TOOL_INPUT" });
  const lines = await tools.registry.read_lines.execute({ path: "backend/example.js", start_line: 1, end_line: 250 });
  assert.equal(lines.stdout.trimEnd(), source(250));
  for (const limit of [251, 500]) {
    await assert.rejects(tools.registry.read_file.execute({ path: "backend/example.js", offset: 1, limit }), { code: "REVIEW_TOOL_INPUT" });
    await assert.rejects(tools.registry.read_lines.execute({ path: "backend/example.js", start_line: 1, end_line: limit }), { code: "READ_LINES_INPUT_INVALID" });
  }
  await writeFile(join(root, "backend/large.js"), "x".repeat(20_000));
  await assert.rejects(tools.registry.read_lines.execute({ path: "backend/large.js", start_line: 1, end_line: 1 }), { code: "REVIEW_TOOL_BUDGET" });
}));

// Demonstrates that a single legal line cannot bypass independent content/output byte ceilings.
test("source readers retain byte ceilings independently of line count", async () => fixture(async ({ root, fileService }) => {
  await writeFile(join(root, "backend/large.js"), "x".repeat(210_000));
  const tool = createReadFileTool({ fileService: { readForIndex: async () => ({ content: "x".repeat(210_000) }) } });
  const result = await tool.execute({ path: "backend/large.js", offset: 1, limit: 250 });
  assert.equal(result.content.length, 200_000);
  assert.equal(result.truncated, true);
  const lines = createSedLinesTool({ projectRoot: root, fileService, toolName: "read_lines", logger: { emit() {} } });
  await assert.rejects(lines.execute({ path: "backend/large.js", start_line: 1, end_line: 1 }, { task_id: "TASK", capabilities: ["read_lines"], allowed_prefixes: ["backend/"] }), { code: "SED_LINES_OUTPUT_TOO_LARGE" });
}));

// Keeps schema consumers and generated instructions aligned without coupling assertions to source whitespace.
test("schema, tool description, and named prompts consistently advertise 250-line source reads", async () => {
  assert.equal(readFileDefinition.input_schema.properties.limit.maximum, 250);
  assert.match(readFileDefinition.description, /up to\s+250\s+source lines/);
  const schema = JSON.parse(await readFile(new URL("../../../schemas/agent/tools/read-file.schema.json", import.meta.url), "utf8").catch(async (error) => {
    if (error.code !== "ENOENT") throw error;
    return readFile(new URL("../../../../schemas/agent/tools/read-file.schema.json", import.meta.url), "utf8");
  }));
  assert.equal(schema.properties.limit.maximum, 250);
  assert.doesNotMatch(schema.properties.limit.description, /\b80\b/);
  for (const path of ["application/owner-sdk-stream.js", "application/sprint-plan-leader.js", "modules/supervisor/nodeforge-task-prompts.js"]) {
    const text = await readFile(new URL(`../../src/${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /(?:at most|more than|through|up to)\s+80\s*(?:physical\s+)?lines|through\s+80\b/);
    assert.match(text, /250/);
  }
});
