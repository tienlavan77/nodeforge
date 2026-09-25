// Verifies Codex command tools are callable through Forge's provider-neutral registry.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";

test("Forge registry exposes scoped rg and sed tools for Codex", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-codex-command-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "backend"));
  await writeFile(join(root, "backend", "example.js"), "// Example\nconst symbol = 1;\n");
  const events = [];
  const registry = createForgeToolRegistry({ projectRoot: root, fileService: createFileService({ projectRoot: root }), protocolStorage: { get: async () => null }, projectLogger: (event) => events.push(event) });
  const context = { task_id: "T-CODEX-COMMAND", capabilities: ["rg_files", "rg_search", "sed_lines"], allowed_file_paths: ["backend/example.js"], allowed_prefixes: ["backend/"] };
  const files = await registry.rg_files.execute({}, context);
  const search = await registry.rg_search.execute({ pattern: "symbol", paths: ["backend"], flags: ["-n"] }, context);
  const lines = await registry.sed_lines.execute({ path: "backend/example.js", start_line: 1, end_line: 2 }, context);
  assert.match(files.stdout, /backend\/example\.js/);
  assert.match(search.stdout, /backend\/example\.js:2:const symbol/);
  assert.equal(lines.stdout, "// Example\nconst symbol = 1;\n");
  assert.match(lines.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.ok(events.some((event) => event.event_name === "forge.sed_lines_completed"));
});
