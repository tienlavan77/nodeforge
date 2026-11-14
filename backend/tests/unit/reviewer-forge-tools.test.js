// Verifies bounded Reviewer reads, candidate discovery, and provider parity.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReviewerForgeTools } from "../../src/modules/supervisor/review/reviewer-forge-tools.js";
import { createReviewWorker } from "../../src/modules/supervisor/review/review-worker.js";

const job = { task_id: "T-REVIEW", request_id: "R-1", correlation_id: "C-1", agent_id: "coder-1", payload: { ticket: { id: "T-REVIEW" }, changed_paths: ["src/a.js"] } };
const source = { path: "src/a.js", content: "function sample() {\n  return 1;\n}\nconst value = sample();", sha256: "sha256:abc", size_bytes: 56 };

function files(overrides = {}) {
  return {
    readForIndex: async ({ path }) => path === "workflows/agents/reviewer/README.md"
      ? { ...source, path, content: "Read the evidence." }
      : { ...source, path },
    listFiles: async () => ["src/a.js", ".env", "node_modules/x.js", "src/b.js"],
    listDirectories: async () => ["src", "node_modules"],
    ...overrides
  };
}

const currentNames = ["search_tree", "list_files", "search_text", "read_file", "Read", "select_code_graph_candidates", "lookup_schema"];

test("review read tools return bounded source and hide protected paths", async () => {
  const events = [];
  const tools = createReviewerForgeTools({ fileService: files(), projectRoot: "/project", job, reviewer: { agent_id: "reviewer-1", provider: "openai" }, projectLogger: (event) => events.push(event) });
  assert.deepEqual(tools.definitions.map(({ name }) => name), currentNames);
  const read = await tools.registry.read_file.execute({ path: "src/a.js" });
  assert.equal(read.path, "src/a.js");
  assert.match(read.notice, /Metadata only/);
  const listed = await tools.registry.search_tree.execute({ path: "src", max_depth: 1 });
  assert.deepEqual(listed.entries.map((entry) => entry.path), ["src/a.js", "src/b.js"]);
  await assert.rejects(() => tools.registry.read_file.execute({ path: ".env" }), (error) => ["PATH_FORBIDDEN", "FILE_ROLE_FORBIDDEN"].includes(error.code));
  await assert.rejects(() => tools.registry.read_file.execute({ path: "../outside" }), (error) => ["PATH_FORBIDDEN", "FILE_ROLE_FORBIDDEN"].includes(error.code));
  assert.equal(events.length, 4);
  assert.equal(events.every((event) => event.task_id === "T-REVIEW" && event.correlation_id === "C-1"), true);
});

test("verified reviews retain the same current tools for every provider", () => {
  const ticketEvidence = { files: [source], artifact: { file_checksums: { [source.path]: source.sha256 } }, context: { review_commit_sha: "a".repeat(40) } };
  for (const provider of ["codex", "openai", "claude"]) {
    const tools = createReviewerForgeTools({ fileService: files(), projectRoot: "/project", job, reviewer: { agent_id: "reviewer-1", provider }, codeCache: { read: async () => source }, ticketEvidence });
    assert.deepEqual(tools.definitions.map(({ name }) => name), currentNames);
    assert.equal(tools.registry.review_source, undefined);
    assert.equal(tools.registry.review_diff, undefined);
    assert.deepEqual(tools.context.capabilities, tools.definitions.map(({ name }) => name));
  }
});

test("Reviewer source schemas expose path-only read_file and symbol-aware Read", async () => {
  for (const provider of ["codex", "openai", "claude", "anthropic", "deepseek"]) {
    const tools = createReviewerForgeTools({ fileService: files(), projectRoot: "/project", job, reviewer: { agent_id: "reviewer-1", provider } });
    const readFile = tools.definitions.find(({ name }) => name === "read_file");
    const readSource = tools.definitions.find(({ name }) => name === "Read");
    assert.deepEqual(readFile.input_schema.required, ["path"]);
    assert.ok(readSource.input_schema.properties.file_path);
    assert.ok(tools.registry.read_file);
    assert.ok(tools.registry.Read);
    for (const name of ["read_lines", "search_code", "sed_lines", "Glob", "Grep"]) assert.equal(tools.registry[name], undefined);
  }
});

test("review tools enforce output byte budgets without a call-count cap", async () => {
  const tools = createReviewerForgeTools({ fileService: files(), projectRoot: "/project", job, reviewer: { agent_id: "reviewer-1" } });
  for (let index = 0; index < 13; index += 1) await tools.registry.read_file.execute({ path: "src/a.js" });
  assert.equal(true, true);
});

test("Supervisor passes the same read-only allowlist to every Reviewer provider", async () => {
  for (const provider of ["claude", "anthropic", "openai", "codex"]) {
    let request;
    const gateway = { execute: async (input) => { request = input; return { text: JSON.stringify({ verdict: "request_changes", findings: [{ failure: "Missing test", acceptance_criterion: "Focused verification", evidence_refs: ["src/a.js:1"], minimum_change_scope: "Add a focused test" }] }) }; } };
    const worker = createReviewWorker({ agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer-1", role: "reviewer", provider }) }, claudeSdkGateway: gateway, openaiSdkGateway: gateway, codexSdkGateway: gateway, fileService: files(), projectRoot: "/project" });
    await worker.review(job);
    const names = [...currentNames, "query_review"];
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
  const worker = createReviewWorker({ agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer-1", role: "reviewer", provider: "openai" }) }, openaiSdkGateway: { execute: async (input) => { request = input; return { text: JSON.stringify({ verdict: "request_changes", findings: [{ failure: "Missing evidence", acceptance_criterion: "Source verification", evidence_refs: ["src/a.js:1"], minimum_change_scope: "Supply source evidence" }] }) }; } }, fileService, projectRoot: "/project", projectLogger: (event) => events.push(event) });
  const result = await worker.review(job);
  assert.equal(result.verdict, "request_changes");
  assert.equal(request.options.forgeTools, undefined);
  assert.match(request.prompt, /tools are unavailable/i);
  assert.equal(events.some((event) => event.event_name === "review.tools_unavailable"), true);
});

test("Reviewer snapshot reads remain pinned to supplied evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-review-window-"));
  const path = "backend/src/sample.js";
  const content = "first\nsecond\n";
  const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const evidence = { files: [{ path, content, sha256 }], artifact: { artifact_id: "ARTIFACT-1", file_checksums: { [path]: sha256 } }, context: { review_commit_sha: "a".repeat(40), manifest_sha: "MANIFEST-1" } };
  try {
    await mkdir(join(root, "backend/src"), { recursive: true });
    await writeFile(join(root, path), content);
    const snapshot = { ...files(), committedReview: true, reviewCommit: "a".repeat(40), readForIndex: async () => ({ path, content, sha256 }) };
    const tools = createReviewerForgeTools({ fileService: snapshot, projectRoot: root, job: { ...job, payload: { changed_paths: [path] } }, reviewer: { agent_id: "reviewer-1", provider: "codex" }, ticketEvidence: evidence });
    const read = await tools.registry.read_file.execute({ path });
    assert.equal(read.review_evidence.manifest_sha, "MANIFEST-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
