// Verifies the five-tool planning surface, search provenance, and independent output budgets on real project files.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createSprintLeaderForgeTools, createSprintLeaderToolOptions } from "../../src/tools/sprint-leader-forge-tools.js";

// Creates isolated source evidence so planning tests cannot read or modify the real repository.
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-sl-tools-"));
  try {
    await mkdir(join(root, "backend", "src", "nested"), { recursive: true });
    await writeFile(join(root, "backend/src/example.js"), "// Example source\nexport const value = 1;\n");
    await writeFile(join(root, "backend/src/nested/other.js"), "// Example source:123:content\n// Example source repeated\n");
    const dependencies = { projectRoot: root, fileService: createFileService({ projectRoot: root }), correlationId: "CORR-1" };
    const profile = { agent_id: "SL-1", agent_name: "Leader", role: "sprint_leader", provider: "codex" };
    await run({ root, dependencies, profile });
  } finally { await rm(root, { recursive: true, force: true }); }
}

// Proves direct searches alone populate provenance, without an indexed-search dependency or prior tree reads.
test("Sprint Leader exposes exactly five readers and records search_text paths", async () => fixture(async ({ dependencies, profile }) => {
  const discoveredPaths = new Set();
  const readReceipts = new Map();
  const events = [];
  const tools = createSprintLeaderForgeTools({ ...dependencies, profile, discoveredPaths, readReceipts, projectLogger: (entry) => events.push(entry) });
  const names = ["search_tree", "list_files", "search_text", "read_file", "read_lines"];
  assert.deepEqual(tools.definitions.map(({ name }) => name), names);
  assert.deepEqual(Object.keys(tools.registry), names);
  assert.deepEqual(tools.context.capabilities, names);
  assert.equal(tools.registry.search_code, undefined);
  assert.equal(tools.registry.write_diff, undefined);
  const searched = await tools.registry.search_text.execute({ pattern: "Example source", paths: ["backend"], flags: ["-n", "-F"] });
  assert.match(searched.stdout, /Example source/);
  assert.deepEqual([...discoveredPaths].sort(), ["backend/src/example.js", "backend/src/nested/other.js"]);
  discoveredPaths.clear();
  await tools.registry.search_text.execute({ pattern: "Example source", paths: ["backend/src/nested/other.js"], flags: [] });
  assert.deepEqual([...discoveredPaths], ["backend/src/nested/other.js"]);
  await tools.registry.search_text.execute({ pattern: "Example source", paths: ["backend/src/nested/other.js"], flags: ["-n"] });
  assert.equal(discoveredPaths.size, 1);
  discoveredPaths.clear();
  const empty = await tools.registry.search_text.execute({ pattern: "missing text", paths: ["backend"], flags: [] });
  assert.equal(empty.stdout, "");
  assert.equal(discoveredPaths.size, 0);
  const tree = await tools.registry.search_tree.execute({ path: "backend", max_depth: 2, limit: 10 });
  assert.ok(tree.entries.some((entry) => entry.path === "backend/src/example.js"));
  const file = await tools.registry.read_file.execute({ path: "backend/src/example.js", offset: 1, limit: 2 });
  assert.match(file.content, /Example source/);
  assert.deepEqual(readReceipts.get(file.path), { path: file.path, sha256: file.sha256 });
  assert.deepEqual(Object.keys(readReceipts.get(file.path)).sort(), ["path", "sha256"]);
  const listed = await tools.registry.list_files.execute({ flags: [] });
  assert.match(listed.stdout, /backend\/src\/example\.js/);
  const lines = await tools.registry.read_lines.execute({ path: "backend/src/example.js", start_line: 1, end_line: 2 });
  assert.match(lines.stdout, /export const value/);
  assert.match(lines.sha256, /^sha256:[a-f0-9]{64}$/);
  await assert.rejects(tools.registry.read_lines.execute({ path: "../outside.js", start_line: 1, end_line: 2 }));
  await assert.rejects(tools.registry.search_text.execute({ pattern: "secret", paths: ["outside"], flags: [] }));
  await assert.rejects(tools.registry.read_file.execute({ path: "backend/secrets/token.js" }), { code: "FILE_ROLE_FORBIDDEN" });
  await assert.rejects(tools.registry.read_file.execute({ path: "../outside.js" }), { code: "PATH_FORBIDDEN" });
  assert.ok(events.some((entry) => entry.event_name === "sprint_leader.tool_call" && entry.payload.tool === "search_text"));
}));

// Ensures SDK adapters cannot reintroduce the retired sixth planning tool.
test("Sprint Leader SDK options preserve the five-tool surface for every provider", async () => fixture(async ({ dependencies, profile }) => {
  for (const provider of ["claude", "anthropic", "codex", "openai"]) {
    const options = createSprintLeaderToolOptions({ ...dependencies, profile: { ...profile, provider } });
    const names = ["search_tree", "list_files", "search_text", "read_file", "read_lines"];
    if (["claude", "anthropic"].includes(provider)) {
      assert.deepEqual(options.tools, ["WebSearch"]);
      assert.deepEqual(options.allowedTools, [...names.map((name) => `mcp__forge__${name}`), "WebSearch"]);
      assert.ok(options.mcpServers.forge);
    } else {
      assert.deepEqual(options.forgeTools.definitions.map(({ name }) => name), names);
      assert.equal(options.sandboxMode, "read-only");
      if (provider === "codex") assert.equal(options.webSearchMode, "live");
      if (provider === "openai") assert.equal(options.builtinWebSearch, true);
    }
  }
}));

// Keeps planning context bounded even though individual source windows now allow 250 lines.
test("Sprint Leader rejects individual and aggregate output overflow", async () => fixture(async ({ root, dependencies, profile }) => {
  await writeFile(join(root, "backend/src/large.js"), "x".repeat(21_000));
  const tools = createSprintLeaderForgeTools({ ...dependencies, profile });
  await assert.rejects(tools.registry.read_lines.execute({ path: "backend/src/large.js", start_line: 1, end_line: 1 }), { code: "SPRINT_LEADER_TOOL_BUDGET" });
  await writeFile(join(root, "backend/src/medium.js"), Array(8).fill("x".repeat(15_000)).join("\n"));
  const aggregate = createSprintLeaderForgeTools({ ...dependencies, profile });
  for (let count = 1; count <= 7; count += 1) await aggregate.registry.read_lines.execute({ path: "backend/src/medium.js", start_line: count, end_line: count });
  await assert.rejects(aggregate.registry.read_lines.execute({ path: "backend/src/medium.js", start_line: 8, end_line: 8 }), { code: "SPRINT_LEADER_TOOL_BUDGET" });
}));

// Checks prompt contracts without depending on formatting or exact whitespace.
test("both Sprint Leader prompts advertise only direct discovery tools", async () => {
  for (const path of ["sprint-plan-leader.js", "ticket-sprint-leader.js"]) {
    const source = await readFile(new URL(`../../src/application/${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bsearch_code\b/);
    for (const name of ["search_tree", "list_files", "search_text", "read_file", "read_lines"]) assert.match(source, new RegExp(`\\b${name}\\b`));
  }
});
