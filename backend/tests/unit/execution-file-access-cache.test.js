/** Verifies that Reviewer read grants remain scoped and revocable even when
 * Coder has already warmed shared cache entries outside the review grant.
 * Cache and graph metadata must never bypass the requesting role's authority. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createCodeCacheService } from "../../src/modules/context/code-cache-service.js";
import { createReadFileTool } from "../../src/tools/governance/agent-lifecycle-tools.js";
import { createSearchCodeTool } from "../../src/tools/discovery/search-code.js";
import { createReadCodeTool } from "../../src/tools/discovery/read-code.js";
import { createSelectCodeGraphCandidatesTool } from "../../src/tools/discovery/select-code-graph-candidates.js";
import { createClaudeFileTools } from "../../src/tools/discovery/claude-file-tools.js";
import { createRaceWorkspace, createCoderContext, sha256 } from "../fixtures/execution-file-access-fixture.js";

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
    role: "reviewer",
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
    role: "reviewer",
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
