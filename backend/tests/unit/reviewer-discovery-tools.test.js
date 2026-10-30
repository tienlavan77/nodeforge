// Verifies existing search and read-only Git tools are available to Reviewer without widening file access.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createOwnerConversationTools } from "../../src/tools/roles/owner-conversation-tools.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/review/reviewer-forge-tools.js";

// Supplies real scoped source plus observable search and Git services without repository mutations.
async function fixture(context, provider = "openai") {
  const root = await mkdtemp(join(tmpdir(), "reviewer-discovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = "src/allowed/sample.js";
  await mkdir(join(root, "src/allowed/secrets"), { recursive: true });
  await mkdir(join(root, "src/other"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs/contract.md"), "needle contract\n");
  await writeFile(join(root, path), "export const needle = 'inside';\n");
  await writeFile(join(root, "src/other/outside.js"), "needle outside\n");
  await writeFile(join(root, "src/allowed/secrets/key.js"), "needle secret\n");
  await symlink(join(root, path), join(root, "src/allowed/link.js"));
  const files = createFileService({ projectRoot: root });
  const calls = [];
  const codeSearch = { search: async (input) => { calls.push({ method: "search", input }); return { matches: [{ node: { path }, score: 1 }, { node: { path: "src/other/outside.js" }, score: 1 }] }; } };
  const gitService = {
    status: async (input) => { calls.push({ method: "status", input }); return ` M ${path}\n`; },
    diffWorkingTree: async (input) => { calls.push({ method: "diff", input }); return `diff --git a/${path} b/${path}\n`; }
  };
  const options = { fileService: files, projectRoot: root, job: { task_id: "review-ticket", payload: { changed_paths: [path] } }, reviewer: { agent_id: "reviewer", provider },
    codeCache: { read: (input) => files.readForIndex(input), prewarm: async () => new Map() }, includeClaudeFileTools: provider === "claude", codeSearch, gitService };
  return { tools: createReviewerForgeTools(options), options, calls, path };
}

test("existing search and Git tools are registered for every Reviewer SDK provider", async (context) => {
  for (const provider of ["codex", "openai", "claude", "deepseek"]) {
    const { tools } = await fixture(context, provider);
    const names = tools.definitions.map(({ name }) => name);
    for (const name of ["search_tree", "list_files", "search_text", "read_file", "read_lines", "git_status", "git_diff"]) {
      assert.equal(names.includes(name), true);
      assert.equal(typeof tools.registry[name].execute, "function");
      assert.equal(tools.context.capabilities.includes(name), true);
    }
    for (const name of ["review_source", "review_diff", "commit_changes", "push_commit", "write_diff", "run_test"]) assert.equal(tools.registry[name], undefined);
  }
});

test("list_files and search_text discover related project source beyond changed paths while protecting private files", async (context) => {
  const { tools, path } = await fixture(context);
  const listed = await tools.registry.list_files.execute({});
  assert.deepEqual(listed.stdout.trim().split("\n").sort(), [path, "src/other/outside.js", "docs/contract.md"].sort());
  const text = await tools.registry.search_text.execute({ pattern: "needle", paths: ["src"], flags: ["-n", "--max-count=2"] });
  assert.equal(text.exit_code, 0);
  assert.match(text.stdout, /src\/allowed\/sample.js:1:/);
  assert.match(text.stdout, /src\/other\/outside.js:1:/);
  assert.doesNotMatch(text.stdout, /secret|link.js/);
  assert.match((await tools.registry.search_text.execute({ pattern: "needle", paths: ["docs"] })).stdout, /docs\/contract.md:/);
  await assert.rejects(() => tools.registry.search_text.execute({ pattern: "needle", paths: ["../outside"] }), { code: "RG_SEARCH_INPUT_INVALID" });
  await assert.rejects(() => tools.registry.search_text.execute({ pattern: "needle", paths: ["src"], flags: ["--pre=command"] }), { code: "RG_SEARCH_INPUT_INVALID" });
});

test("Git reads receive only approved files and cannot accept commands or revision arguments", async (context) => {
  const { tools, calls, path } = await fixture(context);
  assert.equal((await tools.registry.git_status.execute({})).changed_files, 1);
  assert.equal((await tools.registry.git_diff.execute({})).has_changes, true);
  assert.deepEqual(calls, [{ method: "status", input: { paths: [path] } }, { method: "diff", input: { paths: [path] } }]);
  await assert.rejects(() => tools.registry.git_diff.execute({ revision: "HEAD" }), { code: "GIT_READ_INPUT_INVALID" });
  assert.equal(calls.length, 2);
});

test("missing backing services do not advertise unavailable search_code or Git tools", async (context) => {
  const { options } = await fixture(context);
  const tools = createReviewerForgeTools({ ...options, codeSearch: undefined, gitService: undefined });
  assert.equal(tools.registry.search_code, undefined);
  assert.equal(tools.registry.git_status, undefined);
  assert.equal(tools.registry.git_diff, undefined);
  assert.equal(typeof tools.registry.search_text.execute, "function");
});

// Checks owner chat exposes the same read-only Git tools and canonical discovery names.
test("Reviewer owner chat uses canonical Forge tools including read-only Git", async (context) => {
  const { options, calls, path } = await fixture(context);
  const toolContext = { task_id: "review-owner", agent_identity: { agent_id: "reviewer", role: "reviewer" }, allowed_file_paths: [path], allowed_prefixes: [], capabilities: ["search_tree", "list_files", "search_text", "read_file", "read_lines", "git_status", "git_diff"] };
  const tools = createOwnerConversationTools({ ...options, role: "reviewer", context: toolContext });
  assert.deepEqual(tools.definitions.map(({ name }) => name), toolContext.capabilities);
  await tools.registry.git_status.execute({});
  await tools.registry.git_diff.execute({});
  assert.deepEqual(calls, [{ method: "status", input: { paths: [path] } }, { method: "diff", input: { paths: [path] } }]);
  for (const name of ["write_diff", "commit_changes", "push_commit"]) assert.equal(tools.registry[name], undefined);
});
