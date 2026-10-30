/** Verifies project-wide Coder authority through real file tools, versioned
 * authorization, durable change tracking and an actual Git commit. A narrow
 * historical baseline must not block relevant work elsewhere in the project,
 * while unrelated dirty files and filesystem escapes stay excluded. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createCodeCacheService } from "../../src/modules/context/code-cache-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket/ticket-change-ledger.js";
import { createTicketExecutionContextStore } from "../../src/modules/supervisor/ticket/ticket-execution-context.js";
import { createTicketRootCommitService } from "../../src/modules/supervisor/ticket/ticket-root-commit-service.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";
import { bindEngineeringTools } from "../../src/tools/engineering-tool-binding.js";
import { CODER_TOOL_NAMES } from "../../src/tools/engineering-tool-catalog.js";
import { issueExecutionFileAccess } from "../../src/tools/execution-file-access.js";
import { materializeTicketArchive } from "../../src/modules/supervisor/ticket/ticket-archive-materialization.js";

/** Produces the exact content identity required before a Coder mutation. */
const sha = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

test("Coder reads, writes, deletes and moves outside baseline, then commits only its ledger files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nf-coder-project-access-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Inspects and commits only the disposable test repository.
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Forge Test");
  git("config", "user.email", "forge-test@localhost");
  const files = { "src/old.js": "// Supplies an existing ticket module.\nexport const old = true;\n",
    "CLAUDE.md": "# Original instructions\n", "workflows/obsolete.md": "# Obsolete workflow\n",
    ".config/flags.json": "{\"enabled\":false}\n", "unrelated.txt": "original\n" };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  git("add", ".");
  git("commit", "-qm", "baseline");
  const base = git("rev-parse", "HEAD");
  const fileService = createFileService({ projectRoot: root }).forRole("coder");
  const taskId = "TICKET-PROJECT-ACCESS", projectId = "PROJECT-ACCESS";
  const ledger = createTicketChangeLedger({ fileService, projectId });
  const executionContexts = createTicketExecutionContextStore({ fileService, projectId, projectRoot: root });
  const executionContext = await executionContexts.create({ taskId, supervisorId: "SUP", baseSha: base,
    baseline: { file_checksums: { "src/old.js": sha(files["src/old.js"]) }, mutable_file_budget: 1 }, mutableFileBudget: 1 });
  const changeLedger = {
    write: async (change) => { await executionContexts.assertApprovedPath(taskId, change.path); return ledger.write({ ...change, taskId }); },
    move: async (change) => { await executionContexts.assertApprovedPath(taskId, [change.fromPath, change.toPath]); return ledger.move({ ...change, taskId }); },
    snapshot: () => ledger.snapshot(taskId)
  };
  const codeCache = createCodeCacheService({ projectId, fileService });
  const commits = createTicketRootCommitService({ taskId, projectId, projectRoot: root, fileService, ledger, gitService: createGitService({ projectRoot: root }) });
  const registry = createForgeToolRegistry({ protocolStorage: { get: () => null }, fileService, projectRoot: root,
    codeCache, changeLedger, executionContexts, gitService: commits });
  const context = { task_id: taskId, execution_id: "EXEC", project_root: root,
    agent_identity: { agent_id: "CODER", role: "coder", provider: "claude" }, capabilities: [...CODER_TOOL_NAMES],
    allowed_file_paths: ["src/old.js"], allowed_prefixes: ["src"], changed_paths: [], execution_context: executionContext };
  context.file_access_policy = issueExecutionFileAccess({ context, readPrefixes: ["src"],
    policyIdentity: { id: "test", revision: "1", sha256: `sha256:${"a".repeat(64)}` }, authorizeCurrent: () => true });
  context.file_access_version = 2;
  const { registry: tools } = bindEngineeringTools({ registry, context });
  assert.ok((await tools.search_tree.execute({ path: ".config" })).entries.some((entry) => entry.path === ".config/flags.json"));
  assert.match((await tools.read_file.execute({ path: "CLAUDE.md" })).content, /Original/);
  await tools.edit_diff.execute({ path: "CLAUDE.md", before_checksum: sha(files["CLAUDE.md"]), anchor: "Original", replacement: "Updated" });
  await tools.edit_diff.execute({ path: ".config/flags.json", before_checksum: sha(files[".config/flags.json"]), anchor: "false", replacement: "true" });
  const newContent = "// Provides the new module required by the ticket.\n// Exposes its enabled state to project consumers.\nexport const enabled = true;\n";
  await tools.write_diff.execute({ path: "extensions/new.js", before_checksum: null, content: newContent });
  await tools.write_diff.execute({ path: ".forge/config/agent.json", before_checksum: null, content: "{\"enabled\":true}\n" });
  await tools.write_diff.execute({ path: "node_modules/example/source.js", before_checksum: null, content: newContent });
  assert.match((await tools.read_lines.execute({ path: "node_modules/example/source.js", start_line: 1, end_line: 3 })).stdout, /enabled/);
  assert.match((await tools.search_text.execute({ pattern: "true", paths: [".config/flags.json"] })).stdout, /flags.json/);
  assert.match((await tools.search_text.execute({ pattern: "enabled", paths: ["node_modules/example"] })).stdout, /source.js/);
  await tools.move_file.execute({ from_path: "src/old.js", to_path: "docs/relocated.js", before_checksum: sha(files["src/old.js"]) });
  await tools.delete_file.execute({ path: "workflows/obsolete.md", before_checksum: sha(files["workflows/obsolete.md"]) });
  const hidden = await tools.read_file.execute({ path: ".config/flags.json", offset: 1, limit: 1 });
  assert.match(hidden.content, /true/);
  await writeFile(join(root, "unrelated.txt"), "unrelated owner change\n");
  const snapshot = await ledger.snapshot(taskId);
  const expected = [".config/flags.json", ".forge/config/agent.json", "CLAUDE.md", "docs/relocated.js", "extensions/new.js", "node_modules/example/source.js", "src/old.js", "workflows/obsolete.md"].sort();
  assert.deepEqual(Object.keys(snapshot.entries).sort(), expected);
  const synced = await executionContexts.syncManifest(taskId, snapshot);
  assert.deepEqual(synced.manifest_paths, expected);
  await assert.rejects(ledger.write({ taskId: "OTHER", path: "CLAUDE.md", before: "# Updated instructions\n", after: "other" }), { code: "FILE_CLAIM_CONFLICT" });
  for (const path of ["../outside.js", ".git/config", "src/../../outside.js"]) {
    await assert.rejects(tools.read_file.execute({ path, offset: 1, limit: 1 }));
    await assert.rejects(tools.delete_file.execute({ path, before_checksum: sha("x") }));
    await assert.rejects(tools.move_file.execute({ from_path: "extensions/new.js", to_path: path, before_checksum: sha(newContent) }));
  }
  const committed = await tools.commit_changes.execute({ message: "Apply project-wide ticket changes" });
  assert.match(committed.sha, /^[a-f0-9]{40}$/);
  assert.deepEqual(git("diff", "--no-renames", "--name-only", base, committed.sha).split("\n").sort(), expected);
  assert.equal(git("show", `${committed.sha}:unrelated.txt`), "original");
  assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "unrelated owner change\n");
  assert.match(git("show", `${committed.sha}:CLAUDE.md`), /Updated/);
  await writeFile(join(root, "node_modules/example/untracked.js"), "installed dependency\n");
  const archive = await materializeTicketArchive({ projectRoot: root, commitSha: committed.sha });
  try {
    assert.equal(await readFile(join(archive.path, "node_modules/example/source.js"), "utf8"), newContent);
    assert.equal(await readFile(join(archive.path, "node_modules/example/untracked.js"), "utf8"), "installed dependency\n");
    await writeFile(join(archive.path, "node_modules/example/source.js"), "archive-only change");
    assert.equal(await readFile(join(root, "node_modules/example/source.js"), "utf8"), newContent);
  } finally { await archive.cleanup(); }
});
