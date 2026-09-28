// Verifies bounded Reviewer reads and provider-specific tool registration.
import assert from "node:assert/strict";
import test from "node:test";
import { createReviewerForgeTools } from "../../src/modules/supervisor/reviewer-forge-tools.js";
import { createReviewWorker } from "../../src/modules/supervisor/review-worker.js";

const job = { task_id: "T-REVIEW", request_id: "R-1", correlation_id: "C-1", agent_id: "coder-1", payload: { ticket: { id: "T-REVIEW" }, changed_paths: ["src/a.js"] } };
const source = { path: "src/a.js", content: "function sample() {\n  return 1;\n}\nconst value = sample();", sha256: "sha256:abc", size_bytes: 56 };

// Creates a small File Service stub without exposing any write method.
function files(overrides = {}) {
  return { readForIndex: async ({ path }) => path === "workflows/agents/reviewer.md" ? { ...source, path, content: "Read the evidence." } : { ...source, path }, listFiles: async () => ["src/a.js", ".env", "node_modules/x.js", "src/b.js"], listDirectories: async () => ["src", "node_modules"], ...overrides };
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
