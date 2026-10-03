// Verifies Sprint Leader receives only bounded Forge readers on every supported SDK path.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createSprintLeaderForgeTools, createSprintLeaderToolOptions } from "../../src/tools/sprint-leader-forge-tools.js";

// Creates a disposable project to exercise source reads and protected-path filtering.
test("Sprint Leader Forge session searches indexed code and reads only safe project files", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-sl-tools-"));
  try {
    await mkdir(join(root, "backend", "src"), { recursive: true });
    await writeFile(join(root, "backend", "src", "example.js"), "// Example source\nexport const value = 1;\n");
    const fileService = createFileService({ projectRoot: root });
    const codeSearch = { search: async () => ({ matches: [{ node: { path: "backend/src/example.js", language: "javascript" }, score: 1 }, { node: { path: "backend/secrets/token.js" }, score: 0.5 }] }) };
    const profile = { agent_id: "SL-1", agent_name: "Leader", role: "sprint_leader", provider: "codex" };
    const tools = createSprintLeaderForgeTools({ projectRoot: root, fileService, codeSearch, profile, correlationId: "CORR-1" });
    assert.deepEqual(tools.definitions.map(({ name }) => name), ["search_tree", "read_file", "search_code"]);
    assert.equal(tools.registry.write_diff, undefined);
    const found = await tools.registry.search_code.execute({ query: "example", kind: "file" });
    assert.deepEqual(found.matches.map((match) => match.path), ["backend/src/example.js"]);
    const file = await tools.registry.read_file.execute({ path: "backend/src/example.js", offset: 1, limit: 2 });
    assert.match(file.content, /Example source/);
    await assert.rejects(tools.registry.read_file.execute({ path: "backend/secrets/token.js" }), { code: "FILE_ROLE_FORBIDDEN" });
    await assert.rejects(tools.registry.read_file.execute({ path: "../outside.js" }), { code: "PATH_FORBIDDEN" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Confirms all four providers get the same Forge list and Claude loses native tools.
test("Sprint Leader SDK options expose read-only Forge tools to Claude, Anthropic, Codex, and OpenAI", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-sl-options-"));
  try {
    const dependencies = { projectRoot: root, fileService: createFileService({ projectRoot: root }), codeSearch: { search: async () => ({ matches: [] }) }, correlationId: "CORR-2" };
    for (const provider of ["claude", "anthropic", "codex", "openai"]) {
      const options = createSprintLeaderToolOptions({ ...dependencies, profile: { agent_id: `SL-${provider}`, agent_name: "Leader", role: "sprint_leader", provider } });
      if (provider === "claude" || provider === "anthropic") {
        assert.deepEqual(options.tools, []);
        assert.deepEqual(options.allowedTools, ["mcp__forge__search_tree", "mcp__forge__read_file", "mcp__forge__search_code"]);
        assert.ok(options.mcpServers.forge);
      } else {
        assert.deepEqual(options.forgeTools.definitions.map(({ name }) => name), ["search_tree", "read_file", "search_code"]);
        assert.equal(options.sandboxMode, "read-only");
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
