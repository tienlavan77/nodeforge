// Verifies bounded Reviewer reads and provider-specific tool registration.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/reviewer-forge-tools.js";
import { createReviewWorker } from "../../src/modules/supervisor/review-worker.js";

const job = { task_id: "T-REVIEW", request_id: "R-1", correlation_id: "C-1", agent_id: "coder-1", payload: { ticket: { id: "T-REVIEW" }, changed_paths: ["src/a.js"] } };
const source = { path: "src/a.js", content: "function sample() {\n  return 1;\n}\nconst value = sample();", sha256: "sha256:abc", size_bytes: 56 };

// Creates a small File Service stub without exposing any write method.
function files(overrides = {}) {
  return { readForIndex: async ({ path }) => path === "workflows/agents/reviewer/README.md" ? { ...source, path, content: "Read the evidence." } : { ...source, path }, listFiles: async () => ["src/a.js", ".env", "node_modules/x.js", "src/b.js"], listDirectories: async () => ["src", "node_modules"], ...overrides };
}

test("review read tools return bounded source and hide protected paths", async () => {
  const events = [];
  const tools = createReviewerForgeTools({ fileService: files(), projectRoot: "/project", job, reviewer: { agent_id: "reviewer-1", provider: "openai" }, projectLogger: (event) => events.push(event) });
  assert.deepEqual(tools.definitions.map(({ name }) => name), ["read_file", "search_tree"]);
  const read = await tools.registry.read_file.execute({ path: "src/a.js", symbol: "sample" });
  assert.match(read.content, /function sample/);
  const window = await tools.registry.read_file.execute({ path: "src/a.js", offset: 2, limit: 2 });
  assert.equal(window.content, "  return 1;\n}");
  const listed = await tools.registry.search_tree.execute({ path: "src", max_depth: 1 });
  assert.deepEqual(listed.entries.map((entry) => entry.path), ["src/a.js", "src/b.js"]);
  await assert.rejects(() => tools.registry.read_file.execute({ path: ".env" }), (error) => ["PATH_FORBIDDEN", "FILE_ROLE_FORBIDDEN"].includes(error.code));
  await assert.rejects(() => tools.registry.read_file.execute({ path: "../outside" }), (error) => ["PATH_FORBIDDEN", "FILE_ROLE_FORBIDDEN"].includes(error.code));
  await assert.rejects(() => tools.registry.read_file.execute({ path: "src/a.js", offset: 1, limit: 81 }), (error) => error.code === "REVIEW_TOOL_INPUT");
  assert.equal(events.length, 6);
  assert.equal(events.every((event) => event.task_id === "T-REVIEW" && event.correlation_id === "C-1"), true);
  assert.equal(JSON.stringify(events).includes("one"), false);
});

test("Reviewer definitions expose only the fixed search scope and metadata read", async () => {
  const tools = createReviewerForgeTools({ fileService: files(), projectRoot: "/project", job, reviewer: { agent_id: "reviewer-1", provider: "codex" }, codeSearch: { search: async () => ({ matches: [] }) } });
  const read = tools.definitions.find(({ name }) => name === "read_file");
  const search = tools.definitions.find(({ name }) => name === "search_code");
  assert.deepEqual(Object.keys(read.input_schema.properties), ["path"]);
  assert.equal(search.input_schema.properties.allowed_prefixes, undefined);
  const result = await tools.registry.search_code.execute({ query: "sample", allowed_prefixes: ["backend/"] });
  assert.deepEqual(result.matches, []);
});

test("Claude Reviewer Read uses the Coder file_path schema and rejects a missing path", async () => {
  const tools = createReviewerForgeTools({ fileService: files(), projectRoot: "/project", job, reviewer: { agent_id: "reviewer-1", provider: "claude" }, includeClaudeFileTools: true, codeCache: { read: async ({ path }) => ({ path, content: "one\ntwo", sha256: "sha256:x" }) } });
  const read = tools.definitions.find(({ name }) => name === "Read");
  assert.deepEqual(read.input_schema.required, ["file_path", "start_line", "end_line"]);
  assert.match((await tools.registry.Read.execute({ file_path: "src/a.js", start_line: 1, end_line: 1 })).content, /one/);
  await assert.rejects(() => tools.registry.Read.execute({ start_line: 1, end_line: 1 }), (error) => error.code === "CLAUDE_FILE_INPUT_INVALID");
});

test("review tools allow more than 12 calls while enforcing output byte budgets", async () => {
  const tools = createReviewerForgeTools({ fileService: files(), projectRoot: "/project", job, reviewer: { agent_id: "reviewer-1" } });
  for (let index = 0; index < 13; index += 1) await tools.registry.read_file.execute({ path: "src/a.js", offset: 1, limit: 1 });
  const large = createReviewerForgeTools({ fileService: files({ readForIndex: async () => ({ ...source, content: "x".repeat(17_000) }) }), projectRoot: "/project", job, reviewer: { agent_id: "reviewer-1" } });
  await assert.rejects(() => large.registry.read_file.execute({ path: "src/a.js", offset: 1, limit: 1 }), (error) => error.code === "REVIEW_TOOL_BUDGET");
  const budget = createReviewerForgeTools({ fileService: files({ readForIndex: async () => ({ ...source, content: "x".repeat(10_000) }) }), projectRoot: "/project", job, reviewer: { agent_id: "reviewer-1" } });
  let successful = 0;
  for (let index = 0; index < 20; index += 1) {
    try { await budget.registry.read_file.execute({ path: "src/a.js", offset: 1, limit: 1 }); successful += 1; }
    catch (error) { assert.equal(error.code, "REVIEW_TOOL_BUDGET"); break; }
  }
  assert.equal(successful >= 8 && successful < 20, true);
});

test("Supervisor passes the same read-only allowlist to every Reviewer provider", async () => {
  for (const provider of ["claude", "anthropic", "openai", "codex"]) {
    let request;
    const gateway = { execute: async (input) => { request = input; return { text: '{"verdict":"request_changes","findings":["Need a focused test."]}' }; } };
    const worker = createReviewWorker({ agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer-1", role: "reviewer", provider }) }, claudeSdkGateway: gateway, openaiSdkGateway: gateway, codexSdkGateway: gateway, fileService: files(), projectRoot: "/project" });
    await worker.review(job);
    const names = ["read_file", "search_tree"];
    if (provider === "claude" || provider === "anthropic") {
      assert.deepEqual(request.options.allowedTools, names.map((name) => `mcp__forge__${name}`));
      assert.deepEqual(request.options.tools, []);
      assert.equal(Boolean(request.options.mcpServers.forge), true);
    } else {
      assert.deepEqual(request.options.forgeTools.definitions.map(({ name }) => name), names);
    }
  }
});

test("Reviewer falls back to supplied evidence when Forge tools cannot initialize", async () => {
  const events = [];
  let request;
  const fileService = files();
  Object.defineProperty(fileService, "listFiles", { get: () => { throw new Error("Listing service unavailable"); } });
  const worker = createReviewWorker({ agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer-1", role: "reviewer", provider: "openai" }) }, openaiSdkGateway: { execute: async (input) => { request = input; return { text: '{"verdict":"request_changes","findings":["Evidence insufficient."]}' }; } }, fileService, projectRoot: "/project", projectLogger: (event) => events.push(event) });
  const result = await worker.review(job);
  assert.equal(result.verdict, "request_changes");
  assert.equal(request.options.forgeTools, undefined);
  assert.match(request.prompt, /tools are unavailable/i);
  assert.equal(events.some((event) => event.event_name === "review.tools_unavailable"), true);
});

test("Reviewer source windows use committed content despite stale cache formatting and reject real drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-review-window-"));
  const path = "backend/src/sample.js";
  const content = "first\nsecond\n";
  const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const evidence = { files: [{ path, content, sha256 }], artifact: { artifact_id: "ARTIFACT-1", file_checksums: { [path]: sha256 } }, context: { review_commit_sha: "COMMIT-1", manifest_sha: "MANIFEST-1" } };
  try {
    await mkdir(join(root, "backend/src"), { recursive: true });
    await writeFile(join(root, path), content);
    const cache = { read: async () => ({ path, content: "stale\r\nsource", sha256: "sha256:stale", cache: { status: "hit" } }) };
    const reviewJob = { ...job, payload: { changed_paths: [path] } };
    const options = { fileService: createFileService({ projectRoot: root }), projectRoot: root, job: reviewJob, reviewer: { agent_id: "reviewer-1", provider: "codex" }, codeCache: cache, ticketEvidence: evidence };
    const codex = createReviewerForgeTools(options);
    const metadata = await codex.registry.read_file.execute({ path });
    assert.equal(metadata.sha256, sha256);
    assert.equal(metadata.review_evidence.manifest_sha, "MANIFEST-1");
    const offsetWindow = await codex.registry.read_file.execute({ path, offset: 2, limit: 2 });
    assert.equal(offsetWindow.content, "second\n");
    const lines = await codex.registry.sed_lines.execute({ path, start_line: 1, end_line: 2 });
    assert.equal(lines.stdout, "first\nsecond\n");
    assert.equal(lines.sha256, sha256);
    assert.equal(lines.total_lines, 3);
    assert.equal(lines.review_evidence.commit_sha, "COMMIT-1");
    const claude = createReviewerForgeTools({ ...options, reviewer: { agent_id: "reviewer-1", provider: "claude" }, includeClaudeFileTools: true });
    const lastLine = await claude.registry.Read.execute({ file_path: path, start_line: 3, end_line: 3 });
    assert.equal(lastLine.content, "     3→");
    assert.equal(lastLine.total_lines, 3);
    assert.equal((await claude.registry.Read.execute({ file_path: path, start_line: 2, end_line: 3 })).content, "     2→second\n     3→");
    evidence.files[0].content = "tampered\n";
    await assert.rejects(() => codex.registry.read_file.execute({ path, offset: 2, limit: 1 }), (error) => error.code === "REVIEW_SOURCE_MISMATCH");
    await assert.rejects(() => claude.registry.Read.execute({ file_path: path, start_line: 3, end_line: 3 }), (error) => error.code === "REVIEW_SOURCE_MISMATCH");
    evidence.files[0].content = content;
    await writeFile(join(root, path), "changed\n");
    await assert.rejects(() => codex.registry.sed_lines.execute({ path, start_line: 1, end_line: 2 }), (error) => error.code === "REVIEW_SOURCE_MISMATCH");
    await assert.rejects(() => claude.registry.Read.execute({ file_path: path, start_line: 1, end_line: 1 }), (error) => error.code === "REVIEW_SOURCE_MISMATCH");
    await writeFile(join(root, path), content);
    evidence.artifact.file_checksums[path] = "sha256:wrong";
    await assert.rejects(() => codex.registry.sed_lines.execute({ path, start_line: 1, end_line: 2 }), (error) => error.code === "REVIEW_SOURCE_MISMATCH");
  } finally { await rm(root, { recursive: true, force: true }); }
});
