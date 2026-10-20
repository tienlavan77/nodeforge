// Verifies runtime discovery stays within the requested subtree, bypasses source cache, and obeys Stop/output limits.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createRoleFileService } from "../../src/infrastructure/filesystem/file-service-role-policy.js";
import { listAgentFileTree } from "../../src/infrastructure/filesystem/agent-file-tree.js";
import { createOwnerSearchTreeTool } from "../../src/tools/owner-search-tree.js";
import { createRgSearchTool } from "../../src/tools/rg-search.js";
import { runProjectRipgrep } from "../../src/tools/project-ripgrep-runner.js";

// Creates an isolated runtime fixture without touching the live API or agent execution.
async function fixture(context) {
  const projectRoot = await mkdtemp(join(tmpdir(), "nf-runtime-discovery-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, ".forge/runtime/target/deep/deeper"), { recursive: true });
  await mkdir(join(projectRoot, ".forge/runtime/unrelated"));
  await writeFile(join(projectRoot, ".forge/runtime/target/state.json"), '{"status":"needle"}\n');
  await writeFile(join(projectRoot, ".forge/runtime/unrelated/state.json"), '{"status":"unrelated needle"}\n');
  return projectRoot;
}

test("tree traversal never visits unrelated siblings or descends beyond requested depth", async (context) => {
  const projectRoot = await fixture(context);
  const visited = [];
  const result = await listAgentFileTree({ projectRoot, path: ".forge/runtime/target", maxDepth: 1, limit: 10, assertReadPath: async (path) => { visited.push(path); } });
  assert.deepEqual(result.entries.map(({ path }) => path), [".forge/runtime/target/deep", ".forge/runtime/target/state.json"]);
  assert.ok(visited.every((path) => path.startsWith(".forge/runtime/target")));
  assert.ok(!visited.some((path) => path.includes("deeper")));
  const bounded = await listAgentFileTree({ projectRoot, path: ".forge/runtime/target", maxDepth: 8, limit: 1, assertReadPath: async () => {} });
  assert.equal(bounded.entries.length, 1);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.total_is_lower_bound, true);
});

test("owner tree uses bounded File Service traversal and rejects cancelled requests", async (context) => {
  const projectRoot = await fixture(context);
  const fileService = createRoleFileService({ projectRoot, role: "system_engineer", fileService: createFileService({ projectRoot }) });
  const tool = createOwnerSearchTreeTool({ role: "system_engineer", fileService });
  const result = await tool.execute({ path: ".forge/runtime/target", max_depth: 1 });
  assert.equal(result.total, 2);
  const controller = new AbortController(); controller.abort(new Error("Stopped by owner"));
  await assert.rejects(tool.execute({ path: ".forge/runtime/target" }, { abortSignal: controller.signal }), /Stopped by owner/);
});

test("runtime search uses native ripgrep only inside the selected directory and rejects traversal/symlinks", async (context) => {
  const projectRoot = await fixture(context);
  const tool = createRgSearchTool({ projectRoot, toolName: "search_text", logger: { emit() {} }, codeCache: { read() { assert.fail("Runtime search must not populate the source cache"); } } });
  const scope = { task_id: "runtime-search", capabilities: ["search_text"], agent_identity: { role: "system_engineer" } };
  const result = await tool.execute({ paths: [".forge/runtime/target"], pattern: "needle", flags: ["-n"] }, scope);
  assert.match(result.stdout, /target\/state.json/);
  assert.doesNotMatch(result.stdout, /unrelated/);
  await assert.rejects(tool.execute({ paths: [".forge/../src"], pattern: "needle" }, scope), { code: "RG_SEARCH_INPUT_INVALID" });
  await symlink(join(projectRoot, ".forge/runtime/target"), join(projectRoot, ".forge/linked"));
  await assert.rejects(tool.execute({ paths: [".forge/linked/deep"], pattern: "needle" }, scope), { code: "RG_SEARCH_INPUT_INVALID" });
  await assert.rejects(tool.execute({ paths: [".forge"], pattern: "needle" }, { ...scope, agent_identity: { role: "architecture_manager" } }), { code: "RG_SEARCH_INPUT_INVALID" });
});

test("native runtime search bounds huge log lines and terminates on execution cancellation", async (context) => {
  const projectRoot = await fixture(context);
  await writeFile(join(projectRoot, ".forge/runtime/target/large.log"), `needle${"x".repeat(500000)}\n`);
  const tool = createRgSearchTool({ projectRoot, toolName: "search_text", logger: { emit() {} } });
  const scope = { task_id: "bounded-search", capabilities: ["search_text"], agent_identity: { role: "system_engineer" } };
  const result = await tool.execute({ paths: [".forge/runtime/target"], pattern: "needle" }, scope);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 200000);
  const controller = new AbortController();
  const running = runProjectRipgrep(projectRoot, ["--files", "--hidden", "--no-ignore"], process.env, undefined, { signal: controller.signal });
  controller.abort(new Error("Stopped by owner"));
  await assert.rejects(running, /Stopped by owner/);
});
