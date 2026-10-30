// Verifies end-to-end Coder delete_file and move_file mutations through bindEngineeringTools,
// createForgeToolRegistry, TicketChangeLedger, TicketExecutionContext, and CodeCache.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createCodeCacheService } from "../../src/modules/context/code-cache-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket/ticket-change-ledger.js";
import { createTicketExecutionContextStore } from "../../src/modules/supervisor/ticket/ticket-execution-context.js";
import { bindEngineeringTools } from "../../src/tools/engineering-tool-binding.js";
import { CODER_TOOL_NAMES } from "../../src/tools/engineering-tool-catalog.js";
import { issueExecutionFileAccess } from "../../src/tools/execution-file-access.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";

// Computes the canonical sha256 checksum string used by Forge file tools.
const sha256 = (content) => `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

// Checks whether a filesystem path currently exists on disk.
async function pathExists(target) {
  try { await access(target); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

// Constructs a complete Coder ticket workspace with FileService, CodeCache, TicketChangeLedger, and TicketExecutionContext.
async function createCoderMutationFixture({ taskId = "TICKET-MUT-1", projectId = "PROJ-MUT", files = {}, mutablePaths = [], authorizedCreatePrefixes = [], mutableFileBudget = 4, fileServiceOverride = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nf-coder-mutations-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  const baseFileService = createFileService({ projectRoot: root });
  const fileService = fileServiceOverride ? fileServiceOverride(baseFileService, root) : baseFileService;
  const codeCache = createCodeCacheService({ projectId, fileService });
  const ledger = createTicketChangeLedger({ fileService, projectId });
  const executionContexts = createTicketExecutionContextStore({ fileService, projectId, projectRoot: root });
  const fileChecksums = Object.fromEntries(mutablePaths.map((p) => [p, Object.hasOwn(files, p) ? sha256(files[p]) : null]));
  const baseline = { file_checksums: fileChecksums, authorized_create_prefixes: [...authorizedCreatePrefixes], mutable_file_budget: mutableFileBudget };
  const executionContext = await executionContexts.create({ taskId, supervisorId: "SUP-1", baseSha: "a".repeat(40), baseline, authorizedCreatePrefixes, mutableFileBudget });
  const changeLedger = {
    write: async (change) => {
      await executionContexts.assertApprovedPath(taskId, change.path, { operation: change.after === null ? "delete" : "write" });
      return ledger.write({ ...change, taskId });
    },
    move: async (change) => {
      const fromPath = change.fromPath ?? change.from_path, toPath = change.toPath ?? change.to_path;
      await executionContexts.assertApprovedPath(taskId, [{ path: fromPath, allowCreatePrefix: false }, { path: toPath, allowCreatePrefix: true }]);
      return ledger.move({ ...change, fromPath, toPath, taskId });
    },
    load: () => ledger.load(taskId), snapshot: () => ledger.snapshot(taskId),
    rollback: (options) => ledger.rollback(taskId, options), release: (options) => ledger.release(taskId, options)
  };
  const registry = createForgeToolRegistry({
    protocolStorage: { get() { return null; } },
    relevantTreeSelector: { selectRelevantTree() { return []; } },
    freshnessChecker: { ensureFresh() { return { fresh: true }; } },
    fileService, projectRoot: root, codeCache, changeLedger, executionContexts
  });
  const context = {
    task_id: taskId, execution_id: `${taskId}:EXEC-1`, project_id: projectId, project_root: root,
    agent_identity: { agent_id: "CODER-1", role: "coder", provider: "claude" },
    capabilities: [...CODER_TOOL_NAMES], allowed_file_paths: [...new Set([...Object.keys(files), ...mutablePaths])],
    allowed_prefixes: [...authorizedCreatePrefixes], authorized_create_prefixes: [...authorizedCreatePrefixes],
    mutable_file_budget: mutableFileBudget, changed_paths: [], execution_context: executionContext
  };
  context.file_access_policy = issueExecutionFileAccess({
    context, readPaths: [...Object.keys(files)], readPrefixes: ["src", "backend"],
    policyIdentity: { id: "pol-mut", revision: "1", sha256: `sha256:${"b".repeat(64)}` }, authorizeCurrent: () => true
  });
  context.file_access_version = 2;
  const bound = bindEngineeringTools({ registry, context });
  return { root, baseFileService, fileService, codeCache, ledger, changeLedger, executionContexts, bound, context };
}

test("AC-1 & AC-4: Coder delete_file validates project containment and checksum, journals after: null, prunes empty parents, invalidates cache, syncs context, and rolls back cleanly", async () => {
  const initialContent = "// Summary: Obsolete leaf module.\nexport const legacyFlag = true;\n";
  const siblingContent = "// Summary: Active module.\nexport const activeFlag = 1;\n";
  const fixture = await createCoderMutationFixture({
    files: { "src/feature/obsolete/deep/leaf.js": initialContent, "src/feature/active.js": siblingContent, "src/unapproved.js": "// unapproved\n" },
    mutablePaths: ["src/feature/obsolete/deep/leaf.js", "src/feature/active.js"],
    mutableFileBudget: 2
  });
  try {
    const { root, codeCache, ledger, executionContexts, bound } = fixture;
    const targetPath = "src/feature/obsolete/deep/leaf.js";
    assert.equal((await codeCache.read({ path: targetPath })).content, initialContent);

    await assert.rejects(bound.registry.delete_file.execute({ path: "../unapproved.js", before_checksum: sha256("// unapproved\n") }), { code: "TOOL_INPUT_INVALID" });
    assert.equal(await pathExists(join(root, "src/unapproved.js")), true);

    await assert.rejects(bound.registry.delete_file.execute({ path: targetPath, before_checksum: sha256("wrong content") }), { code: "CHECKSUM_MISMATCH" });
    assert.equal(await pathExists(join(root, targetPath)), true);
    assert.deepEqual((await executionContexts.load("TICKET-MUT-1")).manifest_paths, []);

    const delResult = await bound.registry.delete_file.execute({ path: targetPath, before_checksum: sha256(initialContent) });
    assert.equal(delResult.deleted, true);
    assert.equal(delResult.path, targetPath);
    assert.equal(await pathExists(join(root, targetPath)), false);
    assert.equal(await pathExists(join(root, "src/feature/obsolete")), false);
    assert.equal(await pathExists(join(root, "src/feature/active.js")), true);
    await assert.rejects(codeCache.read({ path: targetPath }), { code: "ENOENT" });

    const snapshot = await ledger.snapshot("TICKET-MUT-1");
    assert.equal(snapshot.entries[targetPath].initial_sha, sha256(initialContent));
    assert.equal(snapshot.entries[targetPath].latest_sha, null);
    assert.equal(snapshot.entries[targetPath].operations.at(-1).after, null);
    const syncedContext = await executionContexts.load("TICKET-MUT-1");
    assert.deepEqual(syncedContext.manifest_paths, [targetPath]);
    assert.equal(bound.context.execution_context.manifest_sha, syncedContext.manifest_sha);

    await ledger.rollback("TICKET-MUT-1", { close: false });
    assert.equal(await readFile(join(root, targetPath), "utf8"), initialContent);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("AC-2, AC-4, AC-6, AC-7: Coder move_file moves >250 code_lines without summary-comment or line-budget rejection, journals both endpoints, prunes parents, and rolls back cleanly", async () => {
  const largeLines = `${Array.from({ length: 265 }, (_, idx) => `export const item_${idx} = ${idx};`).join("\n")}\n`;
  const fromPath = "src/legacy/deep/nested/large-module.js";
  const toPath = "src/relocated/sub/large-module.js";
  const fixture = await createCoderMutationFixture({
    files: { [fromPath]: largeLines, "src/occupied.js": "// existing destination\n" },
    mutablePaths: [fromPath, "src/occupied.js"],
    authorizedCreatePrefixes: ["src/relocated"],
    mutableFileBudget: 2
  });
  try {
    const { root, codeCache, ledger, executionContexts, bound } = fixture;
    await codeCache.read({ path: fromPath });

    await assert.rejects(bound.registry.move_file.execute({ from_path: fromPath, to_path: "src/occupied.js", before_checksum: sha256(largeLines) }), { code: "FILE_ALREADY_EXISTS" });
    assert.equal(await readFile(join(root, fromPath), "utf8"), largeLines);
    assert.equal(await readFile(join(root, "src/occupied.js"), "utf8"), "// existing destination\n");
    assert.deepEqual(Object.keys((await ledger.snapshot("TICKET-MUT-1")).entries), []);

    const moveRes = await bound.registry.move_file.execute({ from_path: fromPath, to_path: toPath, before_checksum: sha256(largeLines) });
    assert.equal(moveRes.moved, true);
    assert.equal(moveRes.from_path, fromPath);
    assert.equal(moveRes.to_path, toPath);
    assert.equal(moveRes.sha256, sha256(largeLines));

    assert.equal(await pathExists(join(root, fromPath)), false);
    assert.equal(await pathExists(join(root, "src/legacy")), false);
    assert.equal(await readFile(join(root, toPath), "utf8"), largeLines);
    await assert.rejects(codeCache.read({ path: fromPath }), { code: "ENOENT" });
    assert.equal((await codeCache.read({ path: toPath })).content, largeLines);

    const snap = await ledger.snapshot("TICKET-MUT-1");
    assert.deepEqual(Object.keys(snap.entries).sort(), [fromPath, toPath].sort());
    assert.equal(snap.entries[fromPath].initial_sha, sha256(largeLines));
    assert.equal(snap.entries[fromPath].latest_sha, null);
    assert.equal(snap.entries[fromPath].operations.at(-1).after, null);
    assert.equal(snap.entries[toPath].initial_sha, null);
    assert.equal(snap.entries[toPath].latest_sha, sha256(largeLines));
    assert.equal(snap.entries[toPath].operations.at(-1).before, null);
    assert.equal(snap.entries[toPath].operations.at(-1).after, largeLines);
    assert.deepEqual((await executionContexts.load("TICKET-MUT-1")).manifest_paths, [fromPath, toPath].sort());

    await ledger.rollback("TICKET-MUT-1", { close: false });
    assert.equal(await readFile(join(root, fromPath), "utf8"), largeLines);
    assert.equal(await pathExists(join(root, toPath)), false);
    assert.equal(await pathExists(join(root, "src/relocated")), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("AC-3, AC-5, AC-8, AC-9: claim conflicts and injected write failures preserve source while file budgets do not restrict later repairs", async () => {
  const sourceContent = "// Summary: Source module.\nexport const s = 1;\n";
  let failDeleteSource = false;
  const fixture = await createCoderMutationFixture({
    files: { "src/a.js": sourceContent, "src/b.js": sourceContent, "src/outside.js": sourceContent },
    mutablePaths: ["src/a.js", "src/b.js"],
    authorizedCreatePrefixes: ["src/new"],
    mutableFileBudget: 2,
    fileServiceOverride: (base) => ({
      ...base,
      deleteFile: async (input) => {
        if (failDeleteSource && input.path === "src/a.js") throw Object.assign(new Error("Injected source delete failure"), { code: "EIO" });
        return base.deleteFile(input);
      }
    })
  });
  try {
    const { root, ledger, executionContexts, bound } = fixture;
    failDeleteSource = true;
    await assert.rejects(bound.registry.move_file.execute({ from_path: "src/a.js", to_path: "src/new/moved-a.js", before_checksum: sha256(sourceContent) }), { code: "EIO" });
    failDeleteSource = false;
    assert.equal(await readFile(join(root, "src/a.js"), "utf8"), sourceContent);
    assert.equal(await pathExists(join(root, "src/new/moved-a.js")), false);
    assert.equal(await pathExists(join(root, "src/new")), false);
    assert.deepEqual(Object.keys((await ledger.snapshot("TICKET-MUT-1")).entries), []);
    assert.deepEqual(bound.context.changed_paths, []);

    await ledger.write({ taskId: "OTHER-TICKET", path: "src/b.js", before: sourceContent, after: "// other\n" });
    await assert.rejects(bound.registry.move_file.execute({ from_path: "src/b.js", to_path: "src/new/moved-b.js", before_checksum: sha256("// other\n") }), { code: "FILE_CLAIM_CONFLICT" });
    await ledger.rollback("OTHER-TICKET", { close: true });

    await bound.registry.move_file.execute({ from_path: "src/a.js", to_path: "src/new/moved-a.js", before_checksum: sha256(sourceContent) });
    assert.deepEqual((await executionContexts.load("TICKET-MUT-1")).manifest_paths, ["src/a.js", "src/new/moved-a.js"]);

    await executionContexts.assertApprovedPath("TICKET-MUT-1", "src/b.js", { operation: "delete" });
    await bound.registry.delete_file.execute({ path: "src/b.js", before_checksum: sha256(sourceContent) });
    assert.equal(await pathExists(join(root, "src/b.js")), false);
    assert.equal((await executionContexts.load("TICKET-MUT-1")).manifest_paths.length, 3);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
