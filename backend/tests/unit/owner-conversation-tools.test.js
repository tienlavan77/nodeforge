// Verifies architecture conversation reads and approved document writes through Forge tools.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createOwnerConversationTools } from "../../src/tools/owner-conversation-tools.js";

// Builds a scoped architecture tool registry for a temporary project.
function makeTools(root, writePaths, events) {
  const context = { task_id: "ARCH-1", correlation_id: "ARCH-1", agent_identity: { agent_id: "architecture-manager", role: "architecture_manager", provider: "openai" },
    allowed_write_paths: writePaths, project_root: root };
  const tools = createOwnerConversationTools({ role: "architecture_manager", projectRoot: root,
    fileService: createFileService({ projectRoot: root }), projectLogger: (event) => events.push(event), context });
  context.capabilities = tools.definitions.map((definition) => definition.name);
  return tools;
}

// Reads code and writes only a file explicitly marked as a document patch.
test("architecture tools read files and edit an approved document", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owner-architecture-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  await mkdir(join(root, "docs"));
  await mkdir(join(root, "backend"));
  await writeFile(join(root, "docs", "design.md"), "<!-- Architecture design -->\nOld design\n");
  await writeFile(join(root, "backend", "app.js"), "// Application code\n");
  const events = [];
  const { definitions, registry } = makeTools(root, ["docs/design.md", "docs/new-design.md"], events);
  assert.deepEqual(definitions.map((item) => item.name), ["rg_files", "search_tree", "read_file", "sed_lines", "write_diff", "edit_diff"]);
  const read = await registry.read_file.execute({ path: "docs/design.md" });
  assert.match(read.content, /Old design/);
  const lines = await registry.sed_lines.execute({ path: "docs/design.md", start_line: 1, end_line: 2 });
  assert.match(lines.stdout, /Architecture design/);
  const edited = await registry.edit_diff.execute({ path: "docs/design.md", anchor: "Old design", replacement: "New design", before_checksum: read.sha256 });
  assert.equal(edited.replaced_count, 1);
  await registry.write_diff.execute({ path: "docs/new-design.md", content: "<!-- New design document -->\n", before_checksum: null });
  await assert.rejects(() => registry.write_diff.execute({ path: "docs/unapproved.md", content: "<!-- Not approved -->\n", before_checksum: null }), (error) => error.code === "TOOL_FORBIDDEN");
  await assert.rejects(() => registry.write_diff.execute({ path: "backend/app.js", content: "// Changed", before_checksum: null }), (error) => error.code === "TOOL_FORBIDDEN");
  await assert.rejects(() => registry.read_file.execute({ path: "docs/private-notes.md" }), (error) => error.code === "TOOL_FORBIDDEN");
  assert.ok(events.some((event) => event.event_name === "owner.tool_completed" && event.payload.tool === "edit_diff"));
  assert.ok(events.some((event) => event.event_name === "owner.tool_failed" && event.payload.tool === "write_diff"));
});

// Keeps edit tools hidden when the conversation has no approved patch path.
test("architecture tools without patch scope are read only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owner-architecture-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const { definitions, registry } = makeTools(root, [], []);
  assert.deepEqual(definitions.map((item) => item.name), ["rg_files", "search_tree", "read_file", "sed_lines"]);
  assert.equal(registry.write_diff, undefined);
});
