// Verifies Claude-shaped file tools honor Forge File Service scope, filtering, and audit results.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createRoleFileService } from "../../src/infrastructure/filesystem/file-service-role-policy.js";
import { createClaudeFileTools } from "../../src/tools/claude-file-tools.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";
import { createRuntimeToolGovernance } from "../../src/modules/governance/runtime-tool-governance.js";

test("Read, Glob, and Grep use governed files and record success or rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-claude-tools-"));
  const outside = await mkdtemp(join(tmpdir(), "nodeforge-claude-outside-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "agent.js"), "first\nagent contract\nlast\n");
    await writeFile(join(root, ".env"), "SECRET=hidden\n");
    await writeFile(join(outside, "outside.js"), "agent outside\n");
    await symlink(join(outside, "outside.js"), join(root, "src", "linked.js"));
    const context = { task_id: "CORR-CLAUDE-FILES", agent_identity: { agent_id: "coder", role: "coder" }, allowed_file_paths: ["src/agent.js"], allowed_prefixes: [] };
    const files = createRoleFileService({ fileService: createFileService({ projectRoot: root }), role: "coder", projectRoot: root });
    const registry = createClaudeFileTools({ fileService: files, projectRoot: root });
    const read = await registry.Read.execute({ file_path: join(root, "src", "agent.js"), offset: 2, limit: 1 }, context);
    assert.match(read.content, /2→agent contract/);
    assert.match(read.sha256, /^sha256:/);
    const glob = await registry.Glob.execute({ pattern: "**/*.js" }, context);
    assert.deepEqual(glob.files, ["src/agent.js"]);
    const grep = await registry.Grep.execute({ pattern: "agent", output_mode: "content", glob: "*.js", "-n": true }, context);
    assert.deepEqual(grep.matches.map(({ path, line }) => [path, line]), [["src/agent.js", 2]]);
    const counts = await registry.Grep.execute({ pattern: "agent", output_mode: "count", path: "src" }, context);
    assert.deepEqual(counts.matches, [{ path: "src/agent.js", count: 1 }]);
    await assert.rejects(() => registry.Read.execute({ file_path: ".env" }, context), (error) => error.code === "TOOL_RESOURCE_FORBIDDEN" || error.code === "CLAUDE_FILE_INPUT_INVALID");
    await assert.rejects(() => registry.Read.execute({ file_path: join(outside, "outside.js") }, context), (error) => error.code === "CLAUDE_FILE_INPUT_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Claude coder file calls use Forge registry logging and deny missing capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-claude-registry-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "agent.js"), "// agent contract\n");
    const events = [];
    const registry = createForgeToolRegistry({ projectRoot: root, fileService: createFileService({ projectRoot: root }), protocolStorage: { get: async () => null }, projectLogger: (event) => events.push(event) });
    const context = { task_id: "T-CLAUDE-CODER", capabilities: ["Read", "Glob", "Grep"], allowed_file_paths: ["src/agent.js"], allowed_prefixes: ["src/"] };
    assert.match((await registry.Read.execute({ file_path: "src/agent.js" }, context)).content, /agent contract/);
    assert.deepEqual((await registry.Glob.execute({ pattern: "**/*.js" }, context)).files, ["src/agent.js"]);
    await assert.rejects(() => registry.Read.execute({ file_path: ".env" }, context));
    await assert.rejects(() => registry.Grep.execute({ pattern: "agent" }, { ...context, capabilities: ["Read"] }), (error) => error.code === "TOOL_FORBIDDEN");
    assert.ok(events.some((event) => event.event_name === "forge.tool_success" && event.payload.tool === "Read"));
    assert.ok(events.some((event) => event.event_name === "forge.tool_success" && event.payload.tool === "Glob" && event.payload.result.count === 1));
    assert.ok(events.some((event) => event.event_name === "forge.tool_failed" && event.payload.tool === "Read"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude coder discovery obeys ticket scope under runtime governance", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-claude-scope-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "other"));
    await writeFile(join(root, "src", "allowed.js"), "agent yes\n");
    await writeFile(join(root, "other", "denied.js"), "agent no\n");
    const governance = createRuntimeToolGovernance();
    const context = governance.createExecutionContext({ task_id: "T-CLAUDE-SCOPE", execution_id: "E-CLAUDE-SCOPE", agent_identity: { role: "coder" }, capabilities: ["Read", "Glob", "Grep"], allowed_file_paths: ["src/allowed.js"], allowed_prefixes: ["src/"], context_budget: { max_bytes: 100000, max_calls: 8 } });
    const registry = createForgeToolRegistry({ projectRoot: root, fileService: createFileService({ projectRoot: root }), protocolStorage: { get: async () => null }, governance, projectLogger: () => {} });
    assert.deepEqual((await registry.Glob.execute({ pattern: "**/*.js" }, context)).files, ["src/allowed.js"]);
    assert.deepEqual((await registry.Grep.execute({ pattern: "agent" }, context)).matches, ["src/allowed.js"]);
    await assert.rejects(() => registry.Read.execute({ file_path: "other/denied.js" }, context), (error) => error.code === "TOOL_RESOURCE_FORBIDDEN");
  } finally { await rm(root, { recursive: true, force: true }); }
});
