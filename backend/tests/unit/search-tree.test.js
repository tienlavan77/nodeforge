// Verifies agents see real project structure while ignored and private paths stay hidden.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSearchTreeTool } from "../../src/tools/search-tree.js";

const context = { task_id: "TASK-TREE", capabilities: ["search_tree"], agent_identity: { agent_id: "AM" } };

// Confirms directory discovery preserves empty folders and applies Git ignore rules.
test("search_tree lists real directories and excludes ignored, private, and symlink paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-search-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, ".gitignore"), "dist/\n*.cache\n");
  await mkdir(join(root, "src", "empty"), { recursive: true });
  await mkdir(join(root, ".github"));
  await mkdir(join(root, "dist"));
  await mkdir(join(root, "vendor"));
  await writeFile(join(root, "src", "app.js"), "export const app = true;\n");
  await writeFile(join(root, "src", ".env"), "private\n");
  await writeFile(join(root, "src", "build.cache"), "ignored\n");
  await writeFile(join(root, "dist", "built.js"), "ignored\n");
  await writeFile(join(root, "vendor", "package.js"), "ignored\n");
  await symlink(tmpdir(), join(root, "outside"));
  const events = [];
  const tool = createSearchTreeTool({ projectRoot: root, logger: { emit: (event) => events.push(event) } });
  const result = await tool.execute({ flags: ["--max-depth=3"] }, context);
  assert.deepEqual(result.entries.map((entry) => entry.path), [".github", "src", ".gitignore", "src/empty", "src/app.js"]);
  assert.ok(result.tree.includes("├── src/\n│   ├── empty/\n│   └── app.js"));
  assert.equal(result.truncated, false);
  assert.ok(events.some((event) => event.event_name === "forge.search_tree_completed"));
  const directories = await tool.execute({ flags: ["--dirs-only", "--max-depth=3"] }, context);
  assert.deepEqual(directories.entries.map((entry) => entry.path), [".github", "src", "src/empty"]);
  const bounded = await tool.execute({ flags: ["--max-entries=2"] }, context);
  assert.equal(bounded.entries.length, 2);
  assert.equal(bounded.truncated, true);
  for (const path of [".", "", "/", root]) {
    const fromRoot = await tool.execute({ path, flags: ["--max-depth=1", "--dirs-only"] }, context);
    assert.equal(fromRoot.root, ".");
    assert.ok(fromRoot.tree.startsWith(".\n"));
  }
  const subtree = await tool.execute({ path: join(root, "src"), flags: ["--max-depth=1"] }, context);
  assert.equal(subtree.root, "src");
  assert.match(subtree.tree, /^src\/\n/);
});

// Confirms requests cannot traverse outside the project or enter ignored branches.
test("search_tree rejects unsafe paths and flags", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-search-tree-deny-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, ".gitignore"), "dist/\n");
  await mkdir(join(root, "dist"));
  await mkdir(join(root, "vendor"));
  await symlink(tmpdir(), join(root, "link"));
  const tool = createSearchTreeTool({ projectRoot: root, logger: { emit() {} } });
  for (const input of [{ path: "../" }, { path: "/tmp" }, { path: "dist" }, { path: "vendor" }, { path: "link" }, { path: ".git" }, { flags: ["--hidden"] }, { flags: ["--max-depth=7"] }]) {
    await assert.rejects(() => tool.execute(input, context));
  }
});
