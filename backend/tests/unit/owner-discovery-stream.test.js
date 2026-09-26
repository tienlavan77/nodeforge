// Verifies Codex owner agents share scoped discovery tools without exposing private paths.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnerDiscoveryStream } from "../../src/application/owner-discovery-stream.js";
import { createRuntimeLogger } from "../../src/core/runtime-logger.js";

// Confirms the Codex Architecture Manager receives filtered file paths and can answer after a tool call.
test("Architecture Manager can call scoped rg_files in a conversation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-architecture-rg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "app.js"), "export const app = true;\n");
  await writeFile(join(root, "src", "private-key.pem"), "private\n");
  const calls = [];
  const events = [];
  const gateway = { async *stream(input) {
    calls.push(input);
    if (calls.length === 1) yield { tool_use: { id: "call_1", name: "rg_files", input: { flags: [] } } };
    else yield { text: "The project has src/app.js." };
  } };
  const projectLogger = createRuntimeLogger({ logEvent: (event) => events.push(event), output: { write() {} } });
  const stream = createOwnerDiscoveryStream({ agentGateway: gateway, agentConfiguration: { getById: () => ({ role: "architecture_manager", provider: "codex" }) }, projectRoot: root, projectLogger: projectLogger.emit });
  const chunks = [];
  for await (const chunk of stream({ agentId: "AM", payload: { text: "List files" }, correlationId: "CORR-AM-LIST" })) chunks.push(chunk);
  const result = JSON.parse(calls[1].payload.messages.at(-1).output);
  assert.deepEqual(result.paths, ["src/app.js"]);
  assert.equal(result.count, 1);
  assert.equal(calls[1].payload.max_output_tokens, 256);
  assert.equal(calls[1].payload.previous_response_id, undefined);
  assert.equal(calls[0].tools[0].name, "rg_files");
  assert.equal(calls[0].tools[1].name, "search_tree");
  assert.equal(chunks[0].text, "The project has src/app.js.");
  assert.ok(events.some((event) => event.event_name === "forge.rg_files_completed"));
  assert.ok(events.every((event) => typeof event.timestamp === "string" && event.timestamp.length > 0));
});

// Confirms the Architecture Manager can call search_tree and receive real directory entries.
test("Architecture Manager can call search_tree in a conversation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-architecture-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q", root]);
  await mkdir(join(root, "empty"));
  const calls = [];
  const stream = createOwnerDiscoveryStream({ agentGateway: { async *stream(input) {
    calls.push(input);
    if (calls.length === 1) yield { tool_use: { id: "call_tree", name: "search_tree", input: { flags: ["--dirs-only"] } } };
    else yield { text: "Found empty/." };
  } }, agentConfiguration: { getById: () => ({ role: "architecture_manager", provider: "codex" }) }, projectRoot: root, projectLogger: () => {} });
  for await (const chunk of stream({ agentId: "AM", payload: { text: "Show directories" }, correlationId: "CORR-TREE" })) assert.ok(chunk.text);
  const result = JSON.parse(calls[1].payload.messages.at(-1).output);
  assert.deepEqual(result.entries, [{ path: "empty", type: "directory", depth: 1 }]);
  assert.equal(result.tree, ".\n└── empty/");
  assert.equal(calls[1].payload.messages.at(-2).name, "search_tree");
});

// Confirms another Codex role receives the same tool set without a role-specific branch.
test("other Codex conversation roles receive discovery tools", async () => {
  const calls = [];
  const gateway = { async *stream(input) { calls.push(input); yield { text: "available" }; } };
  const stream = createOwnerDiscoveryStream({ agentGateway: gateway, agentConfiguration: { getById: () => ({ role: "sprint_leader", provider: "codex" }) }, projectRoot: process.cwd(), projectLogger: () => {} });
  const chunks = [];
  for await (const chunk of stream({ agentId: "SL", payload: { text: "Plan" }, correlationId: "CORR-SL" })) chunks.push(chunk);
  assert.deepEqual(calls[0].tools.map((tool) => tool.name), ["rg_files", "search_tree"]);
  assert.equal(chunks[0].text, "available");
});

// Confirms providers without the Codex function-call adapter keep their original stream.
test("non-Codex conversation providers keep their original stream", async () => {
  const calls = [];
  const gateway = { async *stream(input) { calls.push(input); yield { text: "unchanged" }; } };
  const stream = createOwnerDiscoveryStream({ agentGateway: gateway, agentConfiguration: { getById: () => ({ role: "reviewer", provider: "claude" }) }, projectRoot: process.cwd(), projectLogger: () => {} });
  const chunks = [];
  for await (const chunk of stream({ agentId: "RV", payload: { text: "Review" }, correlationId: "CORR-RV" })) chunks.push(chunk);
  assert.equal(calls[0].tools, undefined);
  assert.equal(chunks[0].text, "unchanged");
});
