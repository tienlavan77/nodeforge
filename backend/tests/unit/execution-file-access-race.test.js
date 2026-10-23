// Exercises coordinated check-to-use filesystem races and warm-cache/index/graph authority changes
// against real project directories, proving that symlink/ancestor swaps after preflight and shrunk
// or revoked v2 grants fail closed while regular approved files succeed.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createCodeCacheService } from "../../src/modules/context/code-cache-service.js";
import { issueExecutionFileAccess } from "../../src/tools/execution-file-access.js";
import { bindEngineeringTools } from "../../src/tools/engineering-tool-binding.js";
import { engineeringToolImplementations } from "../../src/tools/engineering-tool-implementations.js";
import { createReadFileTool, createWriteDiffTool, createEditDiffTool } from "../../src/tools/agent-lifecycle-tools.js";
import { createSedLinesTool } from "../../src/tools/sed-lines.js";
import { createRgSearchTool } from "../../src/tools/rg-search.js";
import { createRgFilesTool } from "../../src/tools/rg-files.js";
import { createSearchCodeTool } from "../../src/tools/search-code.js";
import { createReadCodeTool } from "../../src/tools/read-code.js";
import { createSelectCodeGraphCandidatesTool } from "../../src/tools/select-code-graph-candidates.js";
import { createClaudeFileTools } from "../../src/tools/claude-file-tools.js";

// Identifies synthetic Node policy provenance for test contexts without borrowing production state.
const policyIdentity = { id: "race-policy", revision: "1", sha256: `sha256:${"c".repeat(64)}` };

// Computes the sha256 checksum format expected by write_diff and edit_diff preflight checks.
const sha256 = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

// Builds a real temporary project root and an outside directory for symlink-escape race targets.
async function createRaceWorkspace(t) {
  const base = await mkdtemp(join(tmpdir(), "nf-race-boundary-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "project");
  const outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  const files = {
    "backend/target.js": "// Summary: Target module for safe edits.\nexport const target = 1;\n",
    "backend/caller.js": "// Summary: Caller module outside manifest.\nexport const caller = 'SAFE_CALLER';\n",
    "backend/sub/leaf.js": "// Summary: Nested module for ancestor swap.\nexport const leaf = 'SAFE_LEAF';\n",
    "docs/guide.md": "# Guide\nSafe guide content.\n",
    "ui/panel.js": "// Summary: UI module outside narrowed grant.\nexport const ui = 'UI_ONLY';\n",
    ".env": "SECRET_TOKEN=TOP_SECRET_ENV\n",
    "AGENTS.md": "# Governance\nProtected governance instructions.\n"
  };
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content, "utf8");
  }
  await writeFile(join(outside, "external.js"), "// OUTSIDE_SECRET_PAYLOAD\n", "utf8");
  await writeFile(join(outside, "leaf.js"), "// OUTSIDE_ANCESTOR_SWAP_PAYLOAD\n", "utf8");
  return { root, outside, files };
}

// Issues a bound v2 Coder context for the given project root and mutable manifest.
function createCoderContext(root, {
  allowedFiles = ["backend/target.js"],
  createPrefixes = ["backend/new"],
  readPaths = ["package.json"],
  readPrefixes = ["backend", "docs"],
  authorizeCurrent = () => true,
  capabilities = ["read_file", "read_lines", "write_diff", "edit_diff", "list_files", "search_text", "search_tree", "search_code", "read_code", "select_code_graph_candidates"]
} = {}) {
  const checksums = Object.fromEntries(allowedFiles.map((path) => [path, null]));
  const context = {
    task_id: "TASK-RACE",
    execution_id: "EXEC-RACE",
    project_root: root,
    agent_identity: { agent_id: "CODER-1", role: "coder", provider: "claude" },
    capabilities,
    allowed_file_paths: allowedFiles,
    allowed_prefixes: [],
    authorized_create_prefixes: createPrefixes,
    changed_paths: [],
    execution_context: { approved_baseline: { file_checksums: checksums, authorized_create_prefixes: createPrefixes, mutable_file_budget: 4 } }
  };
  context.file_access_policy = issueExecutionFileAccess({ context, readPaths, readPrefixes, policyIdentity, authorizeCurrent });
  context.file_access_version = 2;
  return context;
}

test("R1: coordinated check-to-use leaf symlink and ancestor swap races fail closed across read, write, create, discovery and cache while allow controls succeed", async (t) => {
  const { root, outside, files } = await createRaceWorkspace(t);
  const baseService = createFileService({ projectRoot: root, role: "coder" });
  const hooks = { beforeReadForIndex: null, beforeReadFile: null, beforeAtomicWrite: null };
  const fileService = {
    ...baseService,
    readForIndex: async (input) => { await hooks.beforeReadForIndex?.(input); return baseService.readForIndex(input); },
    readFile: async (input) => { await hooks.beforeReadFile?.(input); return baseService.readFile(input); },
    atomicWrite: async (input) => { await hooks.beforeAtomicWrite?.(input); return baseService.atomicWrite(input); }
  };
  const codeCache = createCodeCacheService({ projectId: "proj-race", fileService });
  const logger = { emit() {} };
  const registry = {
    read_file: createReadFileTool({ fileService, codeCache, projectRoot: root }),
    read_lines: createSedLinesTool({ projectRoot: root, fileService, codeCache, toolName: "read_lines", logger }),
    write_diff: createWriteDiffTool({ fileService, codeCache }),
    edit_diff: createEditDiffTool({ fileService, codeCache }),
    list_files: createRgFilesTool({ projectRoot: root, toolName: "list_files", logger }),
    search_text: createRgSearchTool({ projectRoot: root, codeCache, toolName: "search_text", logger }),
    search_tree: engineeringToolImplementations({ fileService, projectRoot: root, wrap: (tool) => tool }).search_tree
  };
  const context = createCoderContext(root);
  const bound = bindEngineeringTools({ registry, context });

  // 1. Positive allow controls: regular files inside read/write/create scopes succeed.
  const controlLines = await bound.registry.read_lines.execute({ path: "backend/caller.js", start_line: 1, end_line: 2 });
  assert.match(controlLines.stdout, /SAFE_CALLER/);
  const controlRead = await bound.registry.read_file.execute({ path: "backend/caller.js", offset: 1, limit: 2 });
  assert.match(controlRead.content, /SAFE_CALLER/);
  codeCache.invalidate({ path: "backend/caller.js" });

  // 2. Read race: after bindEngineeringTools.assertPath lstat-walks backend/caller.js as a regular
  // file, swap backend/caller.js into a symlink to outside/external.js right before readForIndex opens it.
  const callerAbs = join(root, "backend/caller.js");
  const callerBackup = join(root, "backend/caller.backup.js");
  hooks.beforeReadForIndex = async ({ path }) => {
    if (path === "backend/caller.js") {
      await rename(callerAbs, callerBackup);
      await symlink(join(outside, "external.js"), callerAbs);
    }
  };
  await assert.rejects(
    bound.registry.read_file.execute({ path: "backend/caller.js", offset: 1, limit: 2 }),
    (err) => err.code === "FILE_ACCESS_UNSAFE_PATH" || /Linked paths|unsafe project path/i.test(err.message)
  );
  await unlink(callerAbs);
  await rename(callerBackup, callerAbs);
  hooks.beforeReadForIndex = async ({ path }) => {
    if (path === "backend/caller.js") {
      await rename(callerAbs, callerBackup);
      await symlink(join(root, ".env"), callerAbs);
    }
  };
  await assert.rejects(
    bound.registry.read_lines.execute({ path: "backend/caller.js", start_line: 1, end_line: 2 }),
    (err) => err.code === "FILE_ACCESS_UNSAFE_PATH" || /Linked paths|unsafe project path/i.test(err.message)
  );
  await unlink(callerAbs);
  await rename(callerBackup, callerAbs);
  hooks.beforeReadForIndex = null;

  // 3. Ancestor directory swap race: swap backend/sub for a symlink to outside right after assertPath.
  const subDir = join(root, "backend/sub");
  const subBackup = join(root, "backend/sub.backup");
  hooks.beforeReadForIndex = async ({ path }) => {
    if (path === "backend/sub/leaf.js") {
      await rename(subDir, subBackup);
      await symlink(outside, subDir);
    }
  };
  await assert.rejects(
    bound.registry.read_file.execute({ path: "backend/sub/leaf.js", offset: 1, limit: 2 }),
    (err) => err.code === "FILE_ACCESS_UNSAFE_PATH" || /Linked paths|unsafe project path/i.test(err.message)
  );
  await unlink(subDir);
  await rename(subBackup, subDir);
  hooks.beforeReadForIndex = null;

  // 4. Write/edit race: after write_diff/edit_diff read the original regular file and verified its
  // before_checksum, swap backend/target.js to a symlink pointing to AGENTS.md / outside/external.js
  // right before atomicWrite executes. Neither AGENTS.md nor outside/external.js may be modified.
  const targetAbs = join(root, "backend/target.js");
  const targetBackup = join(root, "backend/target.backup.js");
  const beforeSha = sha256(files["backend/target.js"]);
  hooks.beforeAtomicWrite = async ({ path }) => {
    if (path === "backend/target.js") {
      await rename(targetAbs, targetBackup);
      await symlink(join(root, "AGENTS.md"), targetAbs);
    }
  };
  await assert.rejects(
    bound.registry.write_diff.execute({
      path: "backend/target.js",
      before_checksum: beforeSha,
      content: "// Summary: Attempted overwrite.\nexport const target = 99;\n"
    }),
    (err) => err.code === "FILE_ACCESS_UNSAFE_PATH" || /Linked paths|unsafe project path/i.test(err.message)
  );
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), files["AGENTS.md"]);
  await unlink(targetAbs);
  await rename(targetBackup, targetAbs);

  hooks.beforeAtomicWrite = async ({ path }) => {
    if (path === "backend/target.js") {
      await rename(targetAbs, targetBackup);
      await symlink(join(outside, "external.js"), targetAbs);
    }
  };
  await assert.rejects(
    bound.registry.edit_diff.execute({
      path: "backend/target.js",
      before_checksum: beforeSha,
      anchor: "export const target = 1;",
      replacement: "export const target = 2;"
    }),
    (err) => err.code === "FILE_ACCESS_UNSAFE_PATH" || /Linked paths|unsafe project path/i.test(err.message)
  );
  assert.equal(await readFile(join(outside, "external.js"), "utf8"), "// OUTSIDE_SECRET_PAYLOAD\n");
  await unlink(targetAbs);
  await rename(targetBackup, targetAbs);
  hooks.beforeAtomicWrite = null;

  // 5. Create-prefix race: swap the missing create target or its parent into a symlink before atomicWrite.
  const createdRel = "backend/new/created.js";
  const createdAbs = join(root, createdRel);
  hooks.beforeAtomicWrite = async ({ path }) => {
    if (path === createdRel) {
      await mkdir(dirname(createdAbs), { recursive: true });
      await symlink(join(outside, "external.js"), createdAbs);
    }
  };
  await assert.rejects(
    bound.registry.write_diff.execute({
      path: createdRel,
      before_checksum: null,
      content: "// Summary: Newly created module under authorized prefix.\nexport const created = true;\n"
    }),
    (err) => err.code === "FILE_ACCESS_UNSAFE_PATH" || /Linked paths|unsafe project path/i.test(err.message)
  );
  assert.equal(await readFile(join(outside, "external.js"), "utf8"), "// OUTSIDE_SECRET_PAYLOAD\n");
  await unlink(createdAbs);
  hooks.beforeAtomicWrite = null;

  // Positive control for create + edit on regular file:
  await bound.registry.write_diff.execute({
    path: createdRel,
    before_checksum: null,
    content: "// Summary: Newly created module under authorized prefix.\nexport const created = true;\n"
  });
  assert.match(await readFile(createdAbs, "utf8"), /created = true/);

  // 6. Discovery & cache refresh race: if a listed file becomes a symlink to .env before cache read
  // or refreshChanged, rg_search skips it without leaking .env and codeCache invalidates the entry.
  await codeCache.read({ path: "backend/caller.js" });
  await rename(callerAbs, callerBackup);
  await symlink(join(root, ".env"), callerAbs);
  const refreshStatus = await codeCache.refreshChanged({ path: "backend/caller.js" });
  assert.equal(refreshStatus, "invalidated");
  const searchDuringSwap = await bound.registry.search_text.execute({ pattern: "SECRET_TOKEN|SAFE_CALLER", paths: ["backend"], flags: ["-n"] });
  assert.doesNotMatch(searchDuringSwap.stdout, /TOP_SECRET_ENV|SECRET_TOKEN/);
  await unlink(callerAbs);
  await rename(callerBackup, callerAbs);

  // Protected deny wins even if exact readPaths/allowedFiles include protected or governance paths.
  // Secret-name and dot-file patterns reject inside assertPath's role preflight before grant lookup,
  // while governance/workflow denies surface as PATH_FORBIDDEN from the grant layer.
  const overGranted = createCoderContext(root, {
    allowedFiles: ["backend/target.js", ".env", "AGENTS.md", "workflows/plan.md"],
    readPaths: [".env", "AGENTS.md"],
    readPrefixes: ["backend", "docs", "workflows"]
  });
  const overBound = bindEngineeringTools({ registry, context: overGranted });
  await assert.rejects(overBound.registry.read_file.execute({ path: ".env", offset: 1, limit: 1 }), { code: "FILE_ROLE_FORBIDDEN" });
  await assert.rejects(overBound.registry.write_diff.execute({ path: "AGENTS.md", before_checksum: sha256(files["AGENTS.md"]), content: "# hacked\n" }), { code: "PATH_FORBIDDEN" });
  await assert.rejects(overBound.registry.write_diff.execute({ path: "workflows/plan.md", before_checksum: null, content: "# hacked\n" }), { code: "PATH_FORBIDDEN" });
});

test("R2: warm CodeCache, search_code index/graph, select_code_graph_candidates, read_code and Claude tools obey narrowed and revoked v2 authority on cache hits", async (t) => {
  const { root } = await createRaceWorkspace(t);
  const fileService = createFileService({ projectRoot: root, role: "coder" });
  const callerSha = sha256(await readFile(join(root, "backend/caller.js"), "utf8"));
  const uiSha = sha256(await readFile(join(root, "ui/panel.js"), "utf8"));
  const graph = {
    imports: [{ path: "backend/caller.js" }, { path: "ui/panel.js" }],
    imported_by: [{ path: "ui/panel.js" }],
    calls: [{ caller: { path: "backend/target.js" }, target: { path: "ui/panel.js" } }]
  };
  const codeSearch = {
    fileMetadata: (path) => ({
      sha256: path === "ui/panel.js" ? uiSha : callerSha,
      index_version: "idx-1",
      language: "javascript",
      symbols: [{ name: path === "ui/panel.js" ? "ui" : "caller", kind: "variable", start_line: 2, end_line: 2 }],
      graph
    }),
    search: async () => ({
      index_version: "idx-1",
      matches: [
        { score: 0.9, node: { path: "backend/caller.js", sha256: callerSha, snippet: "SAFE_CALLER", symbols: [{ name: "caller" }], graph } },
        { score: 0.8, node: { path: "ui/panel.js", sha256: uiSha, snippet: "UI_ONLY", symbols: [{ name: "ui" }], graph } }
      ]
    })
  };
  const codeCache = createCodeCacheService({ projectId: "proj-warm", fileService, codeSearch });
  const readFileTool = createReadFileTool({ fileService, codeCache, projectRoot: root });
  const readCodeTool = createReadCodeTool({ fileService, codeCache });
  const searchCodeTool = createSearchCodeTool({ codeSearch, codeCache });
  const candidatesTool = createSelectCodeGraphCandidatesTool({
    relevantTreeSelector: {
      selectFreshWithEmbeddings: async () => ({
        index_version: "idx-1",
        tree: [{ path: "backend/caller.js", score: 1 }, { path: "ui/panel.js", score: 0.9 }],
        stale_paths: ["ui/panel.js"]
      })
    }
  });
  const claudeTools = createClaudeFileTools({ fileService, projectRoot: root, codeCache });

  // Warm the shared cache under broad initial authority (readPrefixes: ["backend", "ui", "docs"]).
  let broadActive = true;
  const broadContext = createCoderContext(root, {
    readPrefixes: ["backend", "ui", "docs"],
    authorizeCurrent: () => broadActive
  });
  const warmUi = await readFileTool.execute({ path: "ui/panel.js", offset: 1, limit: 2 }, broadContext);
  assert.match(warmUi.content, /UI_ONLY/);
  const warmCaller = await readFileTool.execute({ path: "backend/caller.js", offset: 1, limit: 2 }, broadContext);
  assert.equal(warmCaller.cache.status, "miss");
  const hitCaller = await readFileTool.execute({ path: "backend/caller.js", offset: 1, limit: 2 }, broadContext);
  assert.equal(hitCaller.cache.status, "hit");
  assert.equal(hitCaller.code_graph.imports.length, 2);

  // Narrowed authority (only ["backend"], excluding "ui") against the already-warm shared codeCache:
  let narrowActive = true;
  const narrowContext = createCoderContext(root, {
    readPrefixes: ["backend"],
    authorizeCurrent: () => narrowActive
  });
  narrowContext.task_context = {
    title: "Narrow task",
    candidate_files: [
      { path: "backend/caller.js", role: "REFERENCE" },
      { path: "ui/panel.js", role: "REFERENCE" }
    ]
  };

  // Warm cache entry for ui/panel.js must NOT be served across narrowed read scope:
  await assert.rejects(readFileTool.execute({ path: "ui/panel.js", offset: 1, limit: 2 }, narrowContext), { code: "PATH_FORBIDDEN" });
  await assert.rejects(readCodeTool.execute({ kind: "file", path: "ui/panel.js", max_chars: 2000 }, narrowContext), { code: "READ_PATH_FORBIDDEN" });
  await assert.rejects(claudeTools.Read.execute({ file_path: "ui/panel.js", start_line: 1, end_line: 2 }, narrowContext), { code: "TOOL_RESOURCE_FORBIDDEN" });

  // Warm cache hit on backend/caller.js succeeds under narrowContext, but graph edges to ui/panel.js are stripped:
  const narrowHit = await readFileTool.execute({ path: "backend/caller.js", offset: 1, limit: 2 }, narrowContext);
  assert.equal(narrowHit.cache.status, "hit");
  assert.deepEqual(narrowHit.code_graph.imports, [{ path: "backend/caller.js" }]);
  assert.deepEqual(narrowHit.code_graph.imported_by, []);
  assert.deepEqual(narrowHit.code_graph.calls, []);

  // search_code with warm cache and graph projection strips ui/panel.js matches and graph edges:
  const narrowSearch = await searchCodeTool.execute({ query: "export", kind: "file", limit: 10, projection: "graph", allowed_prefixes: ["backend"] }, narrowContext);
  assert.deepEqual(narrowSearch.matches.map((m) => m.path), ["backend/caller.js"]);
  assert.deepEqual(narrowSearch.matches[0].graph.imports, [{ path: "backend/caller.js" }]);
  assert.doesNotMatch(JSON.stringify(narrowSearch), /panel\.js|UI_ONLY/);

  // select_code_graph_candidates filters both ticket-cached candidates and live graph selector results by narrow grant:
  const ticketCandidates = await candidatesTool.execute({ query: "caller", limit: 5 }, narrowContext);
  assert.deepEqual(ticketCandidates.selected.map((c) => c.path), ["backend/caller.js"]);
  delete narrowContext.task_context.candidate_files;
  const liveCandidates = await candidatesTool.execute({ query: "caller", limit: 5 }, narrowContext);
  assert.deepEqual(liveCandidates.selected.map((c) => c.path), ["backend/caller.js"]);
  assert.equal(liveCandidates.stale_paths, undefined);

  // Claude Glob and Grep against warm cache exclude ui/panel.js:
  const globbed = await claudeTools.Glob.execute({ pattern: "**/*.js" }, narrowContext);
  assert.ok(globbed.files.includes("backend/caller.js"));
  assert.ok(!globbed.files.includes("ui/panel.js"));
  const grepped = await claudeTools.Grep.execute({ pattern: "SAFE_CALLER|UI_ONLY", output_mode: "content" }, narrowContext);
  assert.doesNotMatch(JSON.stringify(grepped), /panel\.js|UI_ONLY/);

  // Revoking current authority rejects warm cache hits across every tool immediately:
  narrowActive = false;
  await assert.rejects(readFileTool.execute({ path: "backend/caller.js", offset: 1, limit: 2 }, narrowContext), { code: "FILE_ACCESS_POLICY_INVALID" });
  await assert.rejects(readCodeTool.execute({ kind: "file", path: "backend/caller.js", max_chars: 2000 }, narrowContext), { code: "FILE_ACCESS_POLICY_INVALID" });
  await assert.rejects(searchCodeTool.execute({ query: "export", kind: "file", limit: 5, allowed_prefixes: ["backend"] }, narrowContext), { code: "FILE_ACCESS_POLICY_INVALID" });
  await assert.rejects(candidatesTool.execute({ query: "caller", limit: 5 }, narrowContext), { code: "FILE_ACCESS_POLICY_INVALID" });
  await assert.rejects(claudeTools.Read.execute({ file_path: "backend/caller.js", start_line: 1, end_line: 2 }, narrowContext), { code: "FILE_ACCESS_POLICY_INVALID" });
});
