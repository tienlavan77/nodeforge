// Exercises real Coder read/write races while preventing symlink escapes from the project.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rename, symlink, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createCodeCacheService } from "../../src/modules/context/code-cache-service.js";
import { bindEngineeringTools } from "../../src/tools/engineering-tool-binding.js";
import { engineeringToolImplementations } from "../../src/tools/engineering-tool-implementations.js";
import { createReadFileTool, createWriteDiffTool, createEditDiffTool } from "../../src/tools/governance/agent-lifecycle-tools.js";
import { createSedLinesTool } from "../../src/tools/discovery/sed-lines.js";
import { createRgSearchTool } from "../../src/tools/discovery/rg-search.js";
import { createRgFilesTool } from "../../src/tools/discovery/rg-files.js";

import { createRaceWorkspace, createCoderContext, sha256 } from "../fixtures/execution-file-access-fixture.js";

test("R1: coordinated check-to-use leaf symlink and ancestor swap races fail closed across read, write, create, discovery and cache while allow controls succeed", async (t) => {
  const { root, outside, files } = await createRaceWorkspace(t);
  const baseService = createFileService({ projectRoot: root, role: "coder" });
  const hooks = { beforeReadForIndex: null, beforeReadFile: null, beforeAtomicWrite: null };
  const fileService = {
    ...baseService,
    readForIndex: async (input) => { await hooks.beforeReadForIndex?.(input); return baseService.readForIndex(input); },
    readFile: async (input) => { await hooks.beforeReadFile?.(input); return baseService.readFile(input); },
    atomicWrite: async (input) => { await hooks.beforeAtomicWrite?.(input); return baseService.atomicWrite(input); }
  };
  const codeCache = createCodeCacheService({ projectId: "proj-race", fileService });
  const logger = { emit() {} };
  const registry = {
    read_file: createReadFileTool({ fileService, codeCache, projectRoot: root }),
    read_lines: createSedLinesTool({ projectRoot: root, fileService, codeCache, toolName: "read_lines", logger }),
    write_diff: createWriteDiffTool({ fileService, codeCache }),
    edit_diff: createEditDiffTool({ fileService, codeCache }),
    list_files: createRgFilesTool({ projectRoot: root, toolName: "list_files", logger }),
    search_text: createRgSearchTool({ projectRoot: root, codeCache, toolName: "search_text", logger }),
    search_tree: engineeringToolImplementations({ fileService, projectRoot: root, wrap: (tool) => tool }).search_tree
  };
  const context = createCoderContext(root);
  const bound = bindEngineeringTools({ registry, context });

  // 1. Positive allow controls: regular files inside read/write/create scopes succeed.
  const controlLines = await bound.registry.read_lines.execute({ path: "backend/caller.js", start_line: 1, end_line: 2 });
  assert.match(controlLines.stdout, /SAFE_CALLER/);
  const controlRead = await bound.registry.read_file.execute({ path: "backend/caller.js", offset: 1, limit: 2 });
  assert.match(controlRead.content, /SAFE_CALLER/);
  codeCache.invalidate({ path: "backend/caller.js" });

  // 2. Read race: after bindEngineeringTools.assertPath lstat-walks backend/caller.js as a regular
  // file, swap backend/caller.js into a symlink to outside/external.js right before readForIndex opens it.
  const callerAbs = join(root, "backend/caller.js");
  const callerBackup = join(root, "backend/caller.backup.js");
  hooks.beforeReadForIndex = async ({ path }) => {
    if (path === "backend/caller.js") {
      await rename(callerAbs, callerBackup);
      await symlink(join(outside, "external.js"), callerAbs);
    }
  };
  await assert.rejects(
    bound.registry.read_file.execute({ path: "backend/caller.js", offset: 1, limit: 2 }),
    (err) => err.code === "FILE_ACCESS_UNSAFE_PATH" || /Linked paths|unsafe project path/i.test(err.message)
  );
  await unlink(callerAbs);
  await rename(callerBackup, callerAbs);
  hooks.beforeReadForIndex = async ({ path }) => {
    if (path === "backend/caller.js") {
      await rename(callerAbs, callerBackup);
      await symlink(join(root, ".env"), callerAbs);
    }
  };
  await assert.rejects(
    bound.registry.read_lines.execute({ path: "backend/caller.js", start_line: 1, end_line: 2 }),
    (err) => err.code === "FILE_ACCESS_UNSAFE_PATH" || /Linked paths|unsafe project path/i.test(err.message)
  );
  await unlink(callerAbs);
  await rename(callerBackup, callerAbs);
  hooks.beforeReadForIndex = null;

  // 3. Ancestor directory swap race: swap backend/sub for a symlink to outside right after assertPath.
  const subDir = join(root, "backend/sub");
  const subBackup = join(root, "backend/sub.backup");
  hooks.beforeReadForIndex = async ({ path }) => {
    if (path === "backend/sub/leaf.js") {
      await rename(subDir, subBackup);
      await symlink(outside, subDir);
    }
  };
  await assert.rejects(
    bound.registry.read_file.execute({ path: "backend/sub/leaf.js", offset: 1, limit: 2 }),
    (err) => err.code === "FILE_ACCESS_UNSAFE_PATH" || /Linked paths|unsafe project path/i.test(err.message)
  );
  await unlink(subDir);
  await rename(subBackup, subDir);
  hooks.beforeReadForIndex = null;

  // 4. Write/edit race: after write_diff/edit_diff read the original regular file and verified its
  // before_checksum, swap backend/target.js to a symlink pointing to AGENTS.md / outside/external.js
  // right before atomicWrite executes. Neither AGENTS.md nor outside/external.js may be modified.
  const targetAbs = join(root, "backend/target.js");
  const targetBackup = join(root, "backend/target.backup.js");
  const beforeSha = sha256(files["backend/target.js"]);
  hooks.beforeAtomicWrite = async ({ path }) => {
    if (path === "backend/target.js") {
      await rename(targetAbs, targetBackup);
      await symlink(join(root, "AGENTS.md"), targetAbs);
    }
  };
  await assert.rejects(
    bound.registry.write_diff.execute({
      path: "backend/target.js",
      before_checksum: beforeSha,
      content: "// Summary: Attempted overwrite.\nexport const target = 99;\n"
    }),
    (err) => err.code === "FILE_ACCESS_UNSAFE_PATH" || /Linked paths|unsafe project path/i.test(err.message)
  );
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), files["AGENTS.md"]);
  await unlink(targetAbs);
  await rename(targetBackup, targetAbs);

  hooks.beforeAtomicWrite = async ({ path }) => {
    if (path === "backend/target.js") {
      await rename(targetAbs, targetBackup);
      await symlink(join(outside, "external.js"), targetAbs);
    }
  };
  await assert.rejects(
    bound.registry.edit_diff.execute({
      path: "backend/target.js",
      before_checksum: beforeSha,
      anchor: "export const target = 1;",
      replacement: "export const target = 2;"
    }),
    (err) => err.code === "FILE_ACCESS_UNSAFE_PATH" || /Linked paths|unsafe project path/i.test(err.message)
  );
  assert.equal(await readFile(join(outside, "external.js"), "utf8"), "// OUTSIDE_SECRET_PAYLOAD\n");
  await unlink(targetAbs);
  await rename(targetBackup, targetAbs);
  hooks.beforeAtomicWrite = null;

  // 5. Create-prefix race: swap the missing create target or its parent into a symlink before atomicWrite.
  const createdRel = "backend/new/created.js";
  const createdAbs = join(root, createdRel);
  hooks.beforeAtomicWrite = async ({ path }) => {
    if (path === createdRel) {
      await mkdir(dirname(createdAbs), { recursive: true });
      await symlink(join(outside, "external.js"), createdAbs);
    }
  };
  await assert.rejects(
    bound.registry.write_diff.execute({
      path: createdRel,
      before_checksum: null,
      content: "// Summary: Newly created module under authorized prefix.\nexport const created = true;\n"
    }),
    (err) => err.code === "FILE_ACCESS_UNSAFE_PATH" || /Linked paths|unsafe project path/i.test(err.message)
  );
  assert.equal(await readFile(join(outside, "external.js"), "utf8"), "// OUTSIDE_SECRET_PAYLOAD\n");
  await unlink(createdAbs);
  hooks.beforeAtomicWrite = null;

  // Positive control for create + edit on regular file:
  await bound.registry.write_diff.execute({
    path: createdRel,
    before_checksum: null,
    content: "// Summary: Newly created module under authorized prefix.\nexport const created = true;\n"
  });
  assert.match(await readFile(createdAbs, "utf8"), /created = true/);

  // 6. Discovery & cache refresh race: if a listed file becomes a symlink to .env before cache read
  // or refreshChanged, rg_search skips it without leaking .env and codeCache invalidates the entry.
  await codeCache.read({ path: "backend/caller.js" });
  await rename(callerAbs, callerBackup);
  await symlink(join(root, ".env"), callerAbs);
  const refreshStatus = await codeCache.refreshChanged({ path: "backend/caller.js" });
  assert.equal(refreshStatus, "invalidated");
  const searchDuringSwap = await bound.registry.search_text.execute({ pattern: "SECRET_TOKEN|SAFE_CALLER", paths: ["backend"], flags: ["-n"] });
  assert.doesNotMatch(searchDuringSwap.stdout, /TOP_SECRET_ENV|SECRET_TOKEN/);
  await unlink(callerAbs);
  await rename(callerBackup, callerAbs);

  // Git repository metadata remains unavailable even under broad Coder file authority.
  for (const path of [".git/config", "../outside.js"]) {
    await assert.rejects(bound.registry.read_file.execute({ path, offset: 1, limit: 1 }));
    await assert.rejects(bound.registry.write_diff.execute({ path, before_checksum: null, content: "blocked" }));
  }
});
